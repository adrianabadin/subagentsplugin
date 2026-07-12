/**
 * model-fallback-error-classification (SDD change) — Slice 3, task 20.
 *
 * Spec #1620 "Recursive Retry With Bounded Attempts" (recursive-fallback
 * ADDED requirements). Design #1623 "Fallback mechanism" +
 * "Re-entrancy guard" + "Client wiring".
 *
 * `createFallbackEngine` runs the bounded retry loop: on a classified
 * failure of a tracked `task` call, find the next viable non-quarantined
 * model, re-prompt it via the OpenCode SDK client (`session.create` +
 * `session.prompt`), classify the new result, and either return success
 * (caller overwrites `output.output`/`output.metadata`) or continue to the
 * next attempt. Stops after EXACTLY `maxAttempts` total attempts
 * (including the attempt that triggered the call into this engine) and
 * surfaces a structured terminal error on exhaustion — NEVER a silent
 * empty output.
 *
 * Re-entrancy: every child session the engine creates is registered in
 * `fallbackSessionIDs` BEFORE `session.prompt` is called, so nested
 * `tool.execute.before` / `tool.execute.after` hooks firing for that
 * session (because the fallback session itself dispatches a `task` tool
 * call) can early-return. Combined with the hard `maxAttempts` cap, this
 * makes runaway recursive fallback loops structurally impossible.
 *
 * Client shape is intentionally loose/structural (design #1623 "Client
 * wiring" — no SDK type import). `client.session.create` /
 * `client.session.prompt` are both optional; when either is missing the
 * engine degrades gracefully (treats the loop as immediately exhausted
 * after the one attempt the caller already reports) instead of throwing.
 */

import { resolveQuarantineTtlMs, type QuarantineErrorType, type QuarantineStore } from "./quarantine.js";
import type { ClassifiedError } from "./error-classification.js";
import type { LadderRung } from "./types.js";
import type { Logger } from "./logger.js";
import type { OpenCodeSessionClient } from "./opencode-client.js";

/** A single fallback attempt record (used both mid-loop and in the terminal error). */
export interface FallbackAttempt {
  model: string;
  reason: string;
}

export interface FallbackSuccessResult {
  success: true;
  output: string;
  model: string;
  /** Total attempts consumed, INCLUDING the one that triggered the call (1-indexed). */
  attempts: number;
}

export interface FallbackExhaustedResult {
  success: false;
  /** The formatted "[model-forecast] FALLBACK EXHAUSTED: ..." terminal error string. */
  output: string;
  attempts: FallbackAttempt[];
}

export type FallbackResult = FallbackSuccessResult | FallbackExhaustedResult;

/**
 * Structural shape of the OpenCode SDK client surface that the engine needs.
 */
export interface FallbackClient {
  session?: OpenCodeSessionClient;
}

/**
 * Minimal shape of a `GeneratedProfileCatalog` slice needed to compute
 * `findNextViableModel` — deliberately duplicated (not imported) from
 * `hooks.ts`'s `AfterHookCatalogSlice` so `fallback.ts` and `hooks.ts` do
 * not form an import cycle (`hooks.ts` consumes this module).
 */
export interface FallbackCatalogSlice {
  byBase: Record<string, Array<{ modelId: string; ladderRung?: LadderRung }>>;
}

export interface FallbackEngineDeps {
  client: FallbackClient | undefined;
  quarantine: QuarantineStore;
  catalog: FallbackCatalogSlice;
  ladder: readonly LadderRung[];
  classify: (text: string) => ClassifiedError | null;
  /** Hard cap on TOTAL attempts (including the one that triggered the call). Design mandates exactly 3 in production. */
  maxAttempts: number;
  now?: () => Date;
  logger?: Logger;
}

export interface FallbackRunParams {
  /** The parent (original) session id — used as `parentID` for created child sessions. */
  sessionID: string;
  /** The base subagent_type / phase, used for `agent` on the prompt and in the terminal error message. */
  originalSubagentType: string;
  /** The original task prompt text, re-sent verbatim to each fallback candidate. */
  prompt: string;
  /** The model that failed and triggered this call (attempt 1). */
  failedModel: string;
  /** The classification reason/code for attempt 1's failure (used in the terminal error / attempts log). */
  failureReason: string;
}

export interface FallbackEngine {
  /** Session ids created by this engine — shared re-entrancy guard for before/after hooks. */
  fallbackSessionIDs: Set<string>;
  run: (params: FallbackRunParams) => Promise<FallbackResult>;
}

function extractSessionId(created: unknown): string | undefined {
  if (created === null || typeof created !== "object") return undefined;
  const direct = (created as { id?: unknown }).id;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const info = (created as { info?: { id?: unknown } }).info;
  if (info !== undefined && typeof info === "object" && info !== null) {
    const infoId = (info as { id?: unknown }).id;
    if (typeof infoId === "string" && infoId.length > 0) return infoId;
  }
  const data = (created as { data?: { id?: unknown } }).data;
  if (data !== undefined && typeof data === "object" && data !== null) {
    const dataId = (data as { id?: unknown }).id;
    if (typeof dataId === "string" && dataId.length > 0) return dataId;
  }
  return undefined;
}

function joinTextParts(result: unknown): string {
  if (result === null || typeof result !== "object") return "";
  const parts = (result as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter(
      (part): part is { type: string; text: string } =>
        part !== null &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function splitModelId(modelId: string): { providerID: string; modelID: string } {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return { providerID: "", modelID: modelId };
  return { providerID: modelId.slice(0, slash), modelID: modelId.slice(slash + 1) };
}

/**
 * Finds the next viable (non-quarantined, not-already-attempted-this-run)
 * candidate for `originalSubagentType`, walking the ladder cheapest-first
 * — same algorithm as `hooks.ts`'s `findNextViableModel`, extended with an
 * `excludeModels` set so the engine never re-dispatches a model it already
 * attempted in this run (defense-in-depth on top of quarantine).
 */
function findNextViableModel(
  catalog: FallbackCatalogSlice,
  originalSubagentType: string,
  quarantine: QuarantineStore,
  ladder: readonly LadderRung[],
  excludeModels: ReadonlySet<string>,
): string | null {
  const candidates = catalog.byBase[originalSubagentType] ?? [];
  const byRung = new Map<LadderRung, string[]>();
  for (const candidate of candidates) {
    const rung = candidate.ladderRung;
    if (rung === undefined) continue;
    const list = byRung.get(rung) ?? [];
    list.push(candidate.modelId);
    byRung.set(rung, list);
  }
  for (const rung of ladder) {
    const models = byRung.get(rung);
    if (models === undefined) continue;
    for (const modelId of models) {
      if (excludeModels.has(modelId)) continue;
      if (quarantine.isBlocked(modelId)) continue;
      return modelId;
    }
  }
  return null;
}

/**
 * Formats the terminal "FALLBACK EXHAUSTED" error. Matches design #1623's
 * exact message shape for the canonical 3-attempt case:
 *
 *   [model-forecast] FALLBACK EXHAUSTED: 3 attempts failed for <base>.
 *   Attempts: m1(reason), m2(reason), m3(reason). Manual action required.
 *
 * Generalizes the attempt count so the "all candidates quarantined at
 * dispatch" scenario (which may terminate with fewer than `maxAttempts`
 * recorded attempts) still produces a well-formed, non-empty message.
 */
function formatExhausted(base: string, attempts: readonly FallbackAttempt[]): string {
  const list = attempts.map((attempt) => `${attempt.model}(${attempt.reason})`).join(", ");
  return `[model-forecast] FALLBACK EXHAUSTED: ${attempts.length} attempts failed for ${base}. Attempts: ${list}. Manual action required.`;
}

export function createFallbackEngine(deps: FallbackEngineDeps): FallbackEngine {
  const { quarantine, catalog, ladder, classify, logger } = deps;
  const maxAttempts = deps.maxAttempts;
  const fallbackSessionIDs = new Set<string>();

  async function run(params: FallbackRunParams): Promise<FallbackResult> {
    const attempts: FallbackAttempt[] = [{ model: params.failedModel, reason: params.failureReason }];
    const attemptedModels = new Set<string>([params.failedModel]);

    const sessionApi = deps.client?.session;
    const canDispatch = typeof sessionApi?.create === "function" && typeof sessionApi?.prompt === "function";

    while (attempts.length < maxAttempts) {
      if (!canDispatch) break;

      const nextModel = findNextViableModel(catalog, params.originalSubagentType, quarantine, ladder, attemptedModels);
      if (nextModel === null) {
        logger?.info("fallback", `no viable candidate remains for ${params.originalSubagentType} after ${attempts.length} attempt(s); terminating`);
        break;
      }
      attemptedModels.add(nextModel);

      let sessionId: string | undefined;
      try {
        const created = await Promise.resolve(
          sessionApi!.create!({
            body: {
              parentID: params.sessionID,
              title: `model-forecast fallback attempt ${attempts.length + 1} (${nextModel})`,
            },
          }),
        );
        sessionId = extractSessionId(created);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "session_create_failed";
        logger?.warn("fallback", `session.create threw for ${nextModel}: ${reason}`);
        attempts.push({ model: nextModel, reason: "session_create_failed" });
        quarantine.add(nextModel, "session_create_failed");
        continue;
      }

      if (sessionId === undefined) {
        logger?.warn("fallback", `session.create for ${nextModel} did not return a usable session id`);
        attempts.push({ model: nextModel, reason: "session_create_failed" });
        quarantine.add(nextModel, "session_create_failed");
        continue;
      }

      // Register BEFORE prompting — this is the re-entrancy guard. Any
      // nested tool.execute.before/after hook firing for this sessionID
      // (because the fallback session itself dispatches a task tool call)
      // must see this session id as already-fallback-owned.
      fallbackSessionIDs.add(sessionId);

      const { providerID, modelID } = splitModelId(nextModel);

      let promptResult: unknown;
      try {
        promptResult = await Promise.resolve(
          sessionApi!.prompt!({
            path: { id: sessionId },
            body: {
              model: { providerID, modelID },
              agent: params.originalSubagentType,
              parts: [{ type: "text", text: params.prompt }],
            },
          }),
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : "prompt_failed";
        logger?.warn("fallback", `session.prompt threw for ${nextModel}: ${reason}`);
        attempts.push({ model: nextModel, reason });
        quarantine.add(nextModel, reason);
        continue;
      }

      const text = joinTextParts(promptResult);
      const classified = classify(text);

      if (classified === null || classified.type === "other") {
        // No known error pattern matched — success.
        logger?.info("fallback", `attempt ${attempts.length + 1} succeeded on ${nextModel}`);
        return { success: true, output: text, model: nextModel, attempts: attempts.length + 1 };
      }

      const errorType = classified.type as QuarantineErrorType;
      const ttlMs = resolveQuarantineTtlMs({ errorType, model: nextModel });
      quarantine.add(nextModel, classified.code, ttlMs, errorType);
      logger?.info("fallback", `attempt ${attempts.length + 1} failed on ${nextModel} (${classified.code}); quarantined`);
      attempts.push({ model: nextModel, reason: classified.code });
    }

    const output = formatExhausted(params.originalSubagentType, attempts);
    logger?.warn("fallback", output);
    return { success: false, output, attempts };
  }

  return { fallbackSessionIDs, run };
}
