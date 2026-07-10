/**
 * PR2 — opt-in auto hook + non-breaking audit trail.
 * PR3 — closes PR2 gate #1287 W1 (production hook is non-inert;
 *        candidate wiring is now pluggable).
 *
 * Spec contract (spec #1274 "Default-off plugin behavior" +
 * "Safe task rewrite" + "Non-breaking audit trail"):
 *   - Default plugin returns `{}`. The hook is ONLY registered when
 *     `mode === "auto"` (see src/index.ts:270-274).
 *   - In auto mode, `tool.execute.before` rewrites `task`
 *     `output.args.subagent_type` ONLY when:
 *       (a) the tool id is "task",
 *       (b) `subagent_type` is a non-empty string,
 *       (c) the subagent_type matches the allowlist,
 *       (d) no prior call with the same callID was already handled
 *           (recursion guard),
 *       (e) the selection policy produces a switch decision whose
 *           subagent_type is non-empty AND model is NOT denylisted.
 *   - Refused rewrites MUST:
 *       (1) leave `subagent_type` unchanged,
 *       (2) emit a stderr warning (loud advisory per spec #1274 "Safe
 *           task rewrite" "loud advisory warning"),
 *       (3) record the refusal in the audit trail via `deps.audit`.
 *   - Audit failure MUST NOT break the task call.
 *
 * PR2 gate #1287 W1 (closed in PR3): the original production wiring
 * passed `candidates: []` to `select()` so the hook was inert even in
 * auto mode. PR3:
 *   - Adds an optional `resolveCandidates` factory to
 *     `TaskHookDependencies` so the orchestrator can synthesise
 *     candidates per task call.
 *   - Ships a default factory that constructs ONE candidate on the
 *     cheapest ladder rung from the current subagent_type so the
 *     production hook is non-inert (real `select()` runs end-to-end;
 *     a missing-evidence confidence cap keeps the default outcome
 *     when no scores are available).
 *   - Refines the recursion guard to track by `callID` rather than
 *     `sessionID` so legitimate second-task launches in the same
 *     session are still optimised (S2 gate suggestion).
 */

import { select as defaultSelect } from "./select.js";
import { DEFAULT_LADDER } from "./policy.js";
import { MISSING_EVIDENCE_CONFIDENCE } from "./evidence.js";
import { normalizePhase } from "./phases.js";
import { QuarantineStore, resolveQuarantineTtlMs, type QuarantineErrorType } from "./quarantine.js";
import {
  classifyError,
  extractResetHintMs,
  ERROR_SCAN_WINDOW,
  PROVIDER_ERROR_PATTERN as CLASSIFIER_PROVIDER_ERROR_PATTERN,
  providerErrorCode,
  rateLimitCode,
  type ClassifiedError,
  type ErrorType,
} from "./error-classification.js";
import type { Logger } from "./logger.js";
import type {
  AuditEntry,
  HooksConfig,
  LadderRung,
  SelectCandidate,
  SelectDecision,
  SelectInput,
  SelectionPolicy,
  TaskContext,
} from "./types.js";

interface HookInput {
  tool?: { id?: string; name?: string } | string;
  sessionID?: string;
  callID?: string;
}

interface HookOutput {
  args: Record<string, unknown>;
}

export type TaskHook = (input: HookInput, output: HookOutput) => Promise<void>;

/**
 * Candidates factory: synthesises the candidate set the runner will
 * rank. Returns an empty array (the runner's "no candidates" path)
 * when the factory cannot derive candidates from the current signal.
 *
 * PR3 default factories synthesise a candidate on the cheapest ladder
 * rung marked with the missing-evidence floor so the production hook
 * runs `select()` end-to-end even without orchestrator-supplied
 * scores. Orchestrators that have richer scoring may inject a custom
 * factory at hook construction time.
 */
export type ResolveCandidates = (
  deps: ResolveCandidatesDeps,
) => SelectCandidate[];

export interface ResolveCandidatesDeps {
  /** The original `task` subagent_type. */
  originalSubagentType: string;
  /** The full active ladder (project → plugin → user → built-in). */
  ladder: readonly LadderRung[];
  /** Task context derived from the hook input. */
  context: TaskContext;
  /** Resolved selection policy. */
  policy: SelectionPolicy;
  /** Read-only handle to the hook args (for richer signal mining). */
  args: Readonly<Record<string, unknown>>;
}

export interface TaskHookDependencies {
  /**
   * Optional override for the decision runner. Defaults to the
   * production `defaultSelect` from `./select.js`.
   */
  select?: (input: SelectInput) => SelectDecision;
  /**
   * Optional override for the audit sink. Defaults to a no-op when
   * `undefined` (test-friendly).
   */
  audit?: (entry: AuditEntry) => Promise<void> | void;
  /**
   * PR3 (PR2 gate W1 closure): synthesises the candidate set the
   * runner will rank. When omitted, the hook uses
   * `defaultCandidateFactory` which produces a single
   * cheapest-rung candidate with a missing-evidence confidence cap
   * so the production hook is non-inert end-to-end.
   */
  resolveCandidates?: ResolveCandidates;
  /**
   * PR3: optional sink for loud-advisory stderr warnings when a
   * rewrite is refused (S1). Defaults to `process.stderr.write`
   * so the orchestrator sees the warning at runtime.
   */
  warnSink?: (message: string) => void;
  /**
   * PR3: optional policy loader. Defaults to a noop-friendly stub
   * that uses `config` as-is. Wired so tests + future slices can
   * inject policy files without `createTaskHook` reaching into
   * the file system.
   */
  loadPolicy?: typeof import("./policy.js").loadPolicy;
  /**
   * 429-fallback — tracking map written on every accepted switch. The
   * after hook reads it to recover the canonical model (the lossy
   * `__mf_…` alias cannot be reversed; see design #1317 R11). When
   * omitted, the hook runs without tracking (no 429 fallback).
   */
  tracking?: Map<string, TrackedCall>;
  /** Test helper: clock for deterministic ISO timestamps. */
  now?: () => Date;
  /** Optional logger instance for structured per-call tracing. */
  logger?: Logger;
}

export function toolID(tool: HookInput["tool"]): string {
  if (typeof tool === "string") return tool;
  return tool?.id ?? tool?.name ?? "";
}

function matchesAllowlist(subagentType: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some((entry) => subagentType === entry || subagentType.startsWith(`${entry}-`));
}

function isDenylisted(model: string, denylist: readonly string[]): boolean {
  return denylist.some((entry) => model === entry || model.startsWith(entry));
}

function buildPolicy(config: HooksConfig): SelectionPolicy {
  return {
    mode: config.mode,
    confidenceThreshold: config.confidenceThreshold,
  };
}

function contextFromArgs(args: Record<string, unknown>): TaskContext {
  const raw = typeof args.subagent_type === "string" ? args.subagent_type : "";
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  const description = typeof args.description === "string" ? args.description : "";
  const command = typeof args.command === "string" ? args.command : "";

  // Normalize escalation variants (e.g. `sdd-propose-alto`,
  // `sdd-tasks-fallback`) back to their base phase so downstream
  // rubric/scoring key on the phase, not the variant.
  const phase = normalizePhase(raw).phase;

  // 1. Detect if it's an error correction task (highest priority).
  // Matches vitest/jest failures, bug reports, errors, failed assertions, or explicit fixing.
  const isErrorCorrection =
    /error|fail|broken|bug|crash|exception|remediation|vitest|ts-node|tsc|incorrect|corregir|fix|remediar/i.test(prompt) ||
    /error|fail|bug|fix/i.test(description) ||
    /test|run|check/i.test(command);

  // 2. Detect complexity from prompt & description
  // Simple/deterministic indicators:
  // - very short prompts
  // - mentions of "pre-built", "already designed", "trivial", "mechanical", "pre-armado"
  const isSimple =
    (prompt.length < 150 && !isErrorCorrection) ||
    /pre-built|pre-armado|trivial|simple|only one line|change a comment|mechanical|pre-structured/i.test(prompt);

  // Vague/abstract/heavy design indicators:
  // - long prompts
  // - mentions of "architecture", "vague", "abstract", "design from scratch", "heavy refactoring"
  const isVagueOrAbstract =
    prompt.length > 1000 ||
    /vague|abstract|from scratch|architecture|design pattern|heavy design|refactor/i.test(prompt);

  let contextBreadth: TaskContext["contextBreadth"] = "moderate";
  let riskDomain: string | undefined = undefined;

  if (isErrorCorrection) {
    contextBreadth = "wide"; // force wide/high complexity
    riskDomain = "remediation"; // custom domain to flag correction
  } else if (isSimple) {
    contextBreadth = "narrow";
  } else if (isVagueOrAbstract) {
    contextBreadth = "wide";
    riskDomain = "architecture";
  }

  return {
    phase,
    contextBreadth,
    riskDomain,
  };
}

function keepDefaultFrom(decision: SelectDecision, reason: string): SelectDecision {
  return {
    ...decision,
    action: "keep-default",
    subagent_type: "",
    reason,
  };
}

async function safeAudit(
  deps: TaskHookDependencies,
  entry: AuditEntry,
): Promise<void> {
  try {
    await Promise.resolve(deps.audit?.(entry));
  } catch {
    // Audit must never break the task call.
  }
}

function defaultWarnSink(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // Never let the loud-advisory warning block the task.
  }
}

/**
 * PR3 (PR2 gate W1 closure) — production-grade candidate factory.
 *
 * Constructs ONE candidate on the cheapest ladder rung, marked with
 * the missing-evidence confidence floor and an `evidence` string the
 * runner recognises via `isMissingEvidence` in src/select.ts. This
 * guarantees:
 *   1. The production hook is non-inert — real `select()` runs against
 *      a non-empty candidate set.
 *   2. With no orchestrator scoring, the runner keeps default
 *      (cheapest-rung candidate has capped confidence = MISSING
 *      EVIDENCE floor = 0.1 < default 0.6 threshold).
 *
 * Orchestrators MAY override `resolveCandidates` to inject richer
 * scoring. When they do, this default is bypassed entirely.
 */
export function defaultCandidateFactory(deps: ResolveCandidatesDeps): SelectCandidate[] {
  const cheapestRung = deps.ladder[0] ?? DEFAULT_LADDER[0]!;
  return [
    {
      subagent_type: deps.originalSubagentType,
      model: `${cheapestRung}/${deps.originalSubagentType}`,
      effort: "",
      confidence: MISSING_EVIDENCE_CONFIDENCE,
      evidence: "MISSING_EVIDENCE: no orchestrator scoring supplied to hook",
      ladderRung: cheapestRung,
    },
  ];
}

/**
 * Build the hook. Captures the recursion-guard set in closure so
 * multiple hooks in the same process stay isolated.
 *
 * PR3 (PR2 gate W1): the production hook now drives the REAL
 * `defaultSelect` (no mock) against a synthesised candidate set.
 * The select-and-rewrite path is end-to-end testable without
 * monkey-patching select.
 */

/**
 * 429-fallback (SDD change) — rate-limit detection on task output.
 *
 * Spec #1316 requirement 1. Bounded scan over the first 16 KiB of the
 * output to keep the regex out of pathological inputs. Matches any of
 * the six canonical 429-ish phrasings OpenCode's task tool surfaces
 * (case-insensitive). Returns `true` iff the output looks like a
 * provider rate-limit response.
 */
/**
 * `RATE_LIMIT_SCAN_WINDOW` — kept as a local alias of the canonical
 * `ERROR_SCAN_WINDOW` from `error-classification.ts` so call sites below
 * that still reference it by its historical name do not need renaming.
 */
const RATE_LIMIT_SCAN_WINDOW = ERROR_SCAN_WINDOW;

/**
 * `detectRateLimit` / `detectProviderError` / `matchProviderErrorReason` /
 * `matchReason` are now THIN WRAPPERS over `src/error-classification.ts`'s
 * `classifyError` (design #1623 "Taxonomy location"). Existing exported
 * names and signatures are unchanged — callers outside this module see no
 * difference. `classifyError`'s fixed precedence
 * (model_not_configured > provider_error > rate_limit > other) means a
 * `model_not_configured` match no longer also reports as `rate_limit`
 * from these wrappers; that is the intended, more-correct behavior per
 * spec #1620 "Multiple pattern match precedence".
 */
export function detectRateLimit(output: string): boolean {
  const classified = classifyError(output);
  return classified?.type === "rate_limit";
}

export const PROVIDER_ERROR_PATTERN = CLASSIFIER_PROVIDER_ERROR_PATTERN;

export function detectProviderError(output: string): boolean {
  const classified = classifyError(output);
  return classified?.type === "provider_error";
}

export function matchProviderErrorReason(text: string): string {
  return providerErrorCode(text);
}

/**
 * 429-fallback — parseGeneratedAlias validation guard.
 *
 * Returns the captured `(base, modelSlug, hash)` triple iff `alias`
 * matches the canonical `__mf_<base>__<modelSlug>_<hash6>` shape, else
 * `null`. The modelSlug is the lossy `slug()` projection of the
 * `provider/model-id` — NOT a recoverable `provider/model` (see
 * design #1317 R11). The after hook uses this ONLY as a validation
 * guard before consulting the tracking map for the canonical model.
 */
const ALIAS_PATTERN = /^__mf_([a-z0-9-]+)__([a-z0-9-]+)_([a-z0-9]{1,6})$/;

export interface ParsedAlias {
  base: string;
  modelSlug: string;
  hash: string;
}

export function parseGeneratedAlias(alias: string): ParsedAlias | null {
  if (typeof alias !== "string") return null;
  const match = ALIAS_PATTERN.exec(alias);
  if (match === null) return null;
  return {
    base: match[1] ?? "",
    modelSlug: match[2] ?? "",
    hash: match[3] ?? "",
  };
}

/* -------------------------------------------------------------------------- *
 * 429-fallback — createAfterHook + tracking map.
 * Spec #1316 requirements 1, 4. Fires on `tool.execute.after` for the
 * `task` tool only. When the rewritten alias parses as a generated
 * profile (`__mf_…`) AND the output matches a rate-limit pattern, the
 * tracked model is quarantined and one audit entry + one stderr line
 * are emitted. Sink failures MUST NOT break the hook.
 * -------------------------------------------------------------------------- */

/**
 * Tracking record written by `createTaskHook` on a switch decision.
 * Model is the canonical `provider/model-id` (the lossy alias CANNOT
 * recover it — see design #1317 R11).
 */
export interface TrackedCall {
  originalSubagentType: string;
  targetAlias: string;
  model: string;
}

/**
 * Minimal shape of a `GeneratedProfileCatalog` slice that the after hook
 * needs to compute `nextViableModel`. We accept the full catalog but
 * only read `byBase[originalSubagentType]`.
 */
export interface AfterHookCatalogSlice {
  byBase: Record<string, Array<{ modelId: string }>>;
}

export interface AfterHookDeps {
  quarantine: QuarantineStore;
  tracking: Map<string, TrackedCall>;
  catalog: AfterHookCatalogSlice;
  ladder: readonly LadderRung[];
  audit?: (entry: AuditEntry) => Promise<void> | void;
  warnSink?: (message: string) => void;
  now?: () => Date;
  logger?: Logger;
}

/**
 * Quarantine-audit entry shape (spec #1316 requirement 4). Lives in
 * `hooks.ts` because that's where the entry is produced. The shape is
 * distinguishable from selection entries via `kind: "quarantine"`.
 */
export interface QuarantineAuditEntry {
  kind: "quarantine";
  timestamp: string;
  model: string;
  reason: string;
  callID: string;
  sessionID?: string;
  expiresAt: string;
  nextViableModel: string | null;
}

export type AfterHook = (
  input: HookInput,
  output: { output?: unknown; metadata?: unknown },
) => Promise<void>;

function findNextViableModel(
  catalog: AfterHookCatalogSlice,
  originalSubagentType: string,
  quarantine: QuarantineStore,
  ladder: readonly LadderRung[],
): string | null {
  const candidates = catalog.byBase[originalSubagentType] ?? [];
  // Score in ladder order: cheapest rung first.
  const byRung = new Map<LadderRung, string[]>();
  for (const candidate of candidates) {
    // The catalog entries from profiles.ts include a `ladderRung` field
    // (we use a structural type that only requires modelId, but the
    // real shape includes ladderRung). Cast to access it without
    // re-importing the full catalog type.
    const rung = (candidate as { ladderRung?: LadderRung }).ladderRung;
    if (rung === undefined) continue;
    const list = byRung.get(rung) ?? [];
    list.push(candidate.modelId);
    byRung.set(rung, list);
  }
  for (const rung of ladder) {
    const models = byRung.get(rung);
    if (models === undefined) continue;
    for (const modelId of models) {
      if (!quarantine.isBlocked(modelId)) return modelId;
    }
  }
  return null;
}

export function createAfterHook(deps: AfterHookDeps): AfterHook {
  const { quarantine, tracking, catalog, ladder, audit, warnSink, now, logger } = deps;
  const getNow = now ?? ((): Date => new Date());
  const emit = warnSink ?? defaultWarnSink;

  return async (input, output): Promise<void> => {
    if (toolID(input.tool) !== "task") return;
    const callID = input.callID ?? "";
    if (callID.length === 0) return;
    const tracked = tracking.get(callID);
    if (tracked === undefined) return;
    // Delete-on-consume: a single task call triggers a single quarantine
    // decision. Re-entry with the same callID is silent.
    tracking.delete(callID);

    if (parseGeneratedAlias(tracked.targetAlias) === null) return;

    const text = typeof output.output === "string" ? output.output : "";
    // model-fallback-error-classification (SDD change) — Slice 1, task 8.
    // Spec #1620 "Structured Error Classification": classify via the
    // canonical `classifyError` (model_not_configured > provider_error >
    // rate_limit > other, first-match-wins). `other` (or no failure text
    // at all) means nothing is quarantined and no audit entry is written
    // — mirrors the pre-existing "neither pattern matched" early return.
    const classified: ClassifiedError | null = classifyError(text);
    if (classified === null || classified.type === "other") return;
    const errorType = classified.type as QuarantineErrorType;

    // Best-effort reason: a short label derived from the classifier's
    // matched pattern code. The audit captures the raw excerpt too, so
    // callers can grep their own logs for anything not exhaustively
    // labeled here.
    const reason = classified.code;
    // Prefer a real reset signal from output.metadata when present
    // (design #1623 "Retry-After signal" — best-effort, currently
    // documents that OpenCode never populates these keys); otherwise
    // fall back to the static per-error-type defaults centralized in
    // `resolveQuarantineTtlMs` (quarantine.ts).
    const ttlHintMs = extractResetHintMs(output.metadata);
    const ttlMs = resolveQuarantineTtlMs({ errorType, model: tracked.model, ttlHintMs });
    const entry = quarantine.add(tracked.model, reason, ttlMs, errorType);
    const nextViable = findNextViableModel(
      catalog,
      tracked.originalSubagentType,
      quarantine,
      ladder,
    );

    const expiresAtStr = entry.expiresAt === Infinity ? "Infinity" : new Date(entry.expiresAt).toISOString();

    const auditEntry: QuarantineAuditEntry = {
      kind: "quarantine",
      timestamp: getNow().toISOString(),
      model: tracked.model,
      reason,
      callID,
      sessionID: input.sessionID,
      expiresAt: expiresAtStr,
      nextViableModel: nextViable,
    };

    // safeAudit absorbs throws so the hook resolves cleanly.
    try {
      await Promise.resolve(audit?.(auditEntry as unknown as AuditEntry));
    } catch {
      // Audit must never break the hook.
    }

    logger?.warn(
      "createAfterHook",
      `rate-limit detected for ${tracked.model} (reason=${reason}); quarantined until ${auditEntry.expiresAt}; next viable: ${nextViable ?? "none"}`,
    );

    emit(
      `model-forecast: quarantined ${tracked.model} until ${auditEntry.expiresAt}; next viable: ${
        nextViable ?? "none"
      }`,
    );
  };
}

function matchReason(text: string): string {
  // Thin wrapper over the canonical rate-limit code matcher in
  // error-classification.ts (design #1623 "Taxonomy location").
  return rateLimitCode(text);
}

// NOTE: the google=2h / other=60min static defaults previously computed
// here (`providerOfModel` + `rateLimitTtlMsForModel`) now live in
// `resolveQuarantineTtlMs` (src/quarantine.ts) — centralized there
// because TTL policy is quarantine-domain (design #1623 "Quarantine
// reason").

export function createTaskHook(
  config: HooksConfig,
  deps: TaskHookDependencies = {},
): TaskHook {
  const handledCallIds = new Set<string>();
  const decide = deps.select ?? defaultSelect;
  const resolveCandidates = deps.resolveCandidates ?? defaultCandidateFactory;
  const warnSink = deps.warnSink ?? defaultWarnSink;
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger;

  return async (input, output): Promise<void> => {
    if (config.mode !== "auto") return;
    if (toolID(input.tool) !== "task") return;

    const original = output.args.subagent_type;
    if (typeof original !== "string" || original.length === 0) return;
    if (!matchesAllowlist(original, config.allowlist)) return;

    // PR3 S2 — recursion guard tracks `callID` not `sessionID`. True
    // re-entry (the same hook invocation landing here twice) is
    // bypassed; legitimate second-task launches in the same session
    // are processed.
    const callID = input.callID ?? "";
    if (callID.length > 0 && handledCallIds.has(callID)) return;
    if (callID.length > 0) handledCallIds.add(callID);

    const ladder = config.ladder.length > 0 ? config.ladder : DEFAULT_LADDER;
    const policy = buildPolicy(config);
    const context = contextFromArgs(output.args);
    // Structured phase-detection signal for the audit trail. `false`
    // means the subagent_type did not resolve to a known canonical
    // phase — the task still proceeds (never blocked), the miss is
    // recorded so the user knows the pattern was unmatched.
    const phaseMatched = normalizePhase(original).matched;

    logger?.info(
      "createTaskHook",
      `intercepted task subagent_type=${original} phase=${context.phase} callID=${callID} threshold=${policy.confidenceThreshold}`,
    );

    // PR3 (PR2 gate W1 closure) — synthesise the candidate set. The
    // default factory emits one cheapest-rung candidate so the
    // production hook is non-inert; orchestrators can swap in richer
    // scoring via `deps.resolveCandidates`.
    let candidates: SelectCandidate[];
    try {
      candidates = resolveCandidates({
        originalSubagentType: original,
        ladder,
        context,
        policy,
        args: output.args,
      });
    } catch {
      // A custom resolver MUST NOT break the task call. Fall through
      // with the default factory's single candidate on the cheapest
      // rung so the runner still has a non-empty candidate set.
      logger?.warn(
        "createTaskHook",
        `custom resolver threw for ${original}; falling back to default factory`,
      );
      candidates = defaultCandidateFactory({
        originalSubagentType: original,
        ladder,
        context,
        policy,
        args: output.args,
      });
    }

    logger?.info(
      "createTaskHook",
      `candidates resolved count=${candidates.length} for ${original}` +
        candidates
          .slice(0, 5)
          .map(
            (c) =>
              ` ${c.model}(${c.ladderRung},conf=${c.confidence.toFixed(2)})`,
          )
          .join(""),
    );

    const decision = decide({
      context,
      policy,
      ladder,
      candidates,
    });

    logger?.info(
      "createTaskHook",
      `select decision action=${decision.action} model=${decision.model || "(none)"} confidence=${decision.confidence.toFixed(2)} reason="${decision.reason}"`,
    );

    let finalDecision = decision;
    let refusedReason: string | null = null;

    if (decision.action === "switch" && decision.subagent_type.length === 0) {
      finalDecision = keepDefaultFrom(decision, "alias ladder missing; keeping default");
      refusedReason = "alias ladder missing";
    }
    if (decision.action === "switch" && isDenylisted(decision.model, config.denylist)) {
      finalDecision = keepDefaultFrom(decision, "model denylisted; keeping default");
      refusedReason = `model ${decision.model} is in denylist`;
    }

    if (finalDecision.action === "switch") {
      logger?.info(
        "createTaskHook",
        `switch accepted: ${original} → ${finalDecision.subagent_type} (model=${finalDecision.model})`,
      );
      output.args.subagent_type = finalDecision.subagent_type;
      // 429-fallback — record the rewrite so the after hook can recover
      // the canonical `provider/model-id` (the alias is lossy; see
      // design #1317 R11). FIFO-bounded to 1000 entries (R13) to keep
      // long sessions bounded.
      if (deps.tracking !== undefined && callID.length > 0) {
        if (deps.tracking.size >= 1000) {
          const oldest = deps.tracking.keys().next();
          if (!oldest.done) deps.tracking.delete(oldest.value);
        }
        deps.tracking.set(callID, {
          originalSubagentType: original,
          targetAlias: finalDecision.subagent_type,
          model: finalDecision.model,
        });
      }
    } else if (refusedReason !== null) {
      logger?.warn(
        "createTaskHook",
        `refused auto-mode rewrite for "${original}" — ${refusedReason}; keeping default`,
      );
      // PR3 S1 — loud advisory. Spec #1274 "Safe task rewrite" requires a
      // visible warning when auto mode refuses a rewrite. Audit captures
      // intent; stderr surfaces it to the orchestrator at runtime.
      warnSink(
        `model-forecast: refused auto-mode rewrite for "${original}" — ${refusedReason}; keeping default.`,
      );
    }

    await safeAudit(deps, {
      timestamp: now().toISOString(),
      phase: original,
      originalSubagentType: original,
      decision: finalDecision,
      mode: config.mode,
      sessionID: input.sessionID,
      phaseMatched,
    });
  };
}
