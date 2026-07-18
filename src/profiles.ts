import { normalizeTaskContext } from "./context.js";
import { lookupEvidence } from "./evidence.js";
import { normalizePhase } from "./phases.js";
import { scoreCandidatesAt, type ScoreCandidateInput } from "./scoring.js";
import { lookupBenchmark } from "./benchmark-registry.js";
import type { ResolveCandidates } from "./hooks.js";
import type { QuarantineBlocklist } from "./quarantine.js";
import type { Effort, LadderRung, SelectCandidate, TaskContext } from "./types.js";
import type { EvidenceRecord } from "./evidence.js";
import type { Logger } from "./logger.js";

export const GENERATED_PROFILE_PREFIX = "__mf_";

type JsonishRecord = Record<string, unknown>;

export interface ConnectedProfileModel {
  provider: string;
  model: string;
  modelId: string;
  ladderRung: LadderRung;
  variants?: Effort[];
  evidence?: EvidenceRecord;
}

export interface GeneratedProfile {
  baseAgent: string;
  alias: string;
  provider: string;
  model: string;
  modelId: string;
  ladderRung: LadderRung;
  evidence?: EvidenceRecord;
}

export interface GeneratedProfileCatalog {
  byBase: Record<string, GeneratedProfile[]>;
}

export interface GenerateProfilesOptions {
  phasePrefixes?: string[];
  maxProfilesPerBase?: number;
  /** Exact aliases owned by this plugin instance. Mutated only at commit. */
  ownedAliases?: Set<string>;
}

const DEFAULT_PHASE_PREFIXES = ["sdd-"] as const;

function isRecord(value: unknown): value is JsonishRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonish<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJsonish(item)) as T;
  if (!isRecord(value)) return value;
  const out: JsonishRecord = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = cloneJsonish(nested);
  }
  return out as T;
}

function slug(value: string): string {
  const lower = value.trim().toLowerCase();
  const replaced = lower.replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-");
  const trimmed = replaced.replace(/^-|-$/g, "");
  return trimmed.length > 0 ? trimmed : "profile";
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function generatedProfileAlias(baseAgent: string, modelId: string): string {
  return `${GENERATED_PROFILE_PREFIX}${slug(baseAgent)}__${slug(modelId)}_${stableHash(`${baseAgent}|${modelId}`).slice(0, 6)}`;
}

const MANAGED_ALIAS_PATTERN = /^__mf_[a-z0-9]+(?:-[a-z0-9]+)*__[a-z0-9]+(?:-[a-z0-9]+)*_[a-z0-9]{1,6}(?:-fallback)?$/;

export function isManagedGeneratedAlias(name: string): boolean {
  return MANAGED_ALIAS_PATTERN.test(name);
}

function isVariantProfile(name: string): boolean {
  return name.endsWith("-alto") || name.endsWith("-fallback");
}

function isBasePhaseAgent(name: string, prefixes: readonly string[]): boolean {
  if (isManagedGeneratedAlias(name) || isVariantProfile(name)) return false;
  return prefixes.some((prefix) => name.startsWith(prefix));
}

function providerModelRung(provider: string, model: string): LadderRung {
  const haystack = `${provider}/${model}`.toLowerCase();
  if (haystack.includes("minimax")) return "minimax";
  if (haystack.includes("google") || haystack.includes("gemini") || haystack.includes("antigravity")) {
    return "google-antigravity";
  }
  if (haystack.includes("glm") || haystack.includes("zai")) return "glm-5.2";
  if (haystack.includes("anthropic") || haystack.includes("claude")) return "anthropic";
  return "openai";
}

function evidenceAvailability(status: unknown): EvidenceRecord["availability"] {
  if (status === "deprecated") return "unavailable";
  if (status === "active" || status === undefined) return "available";
  return "unknown";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function evidenceFromModel(provider: string, model: string, rawModel: unknown): EvidenceRecord {
  // 1) Static evidence registry (curated, highest confidence per model).
  const modelKey = `${provider}/${model}`;
  const evidence = lookupEvidence(modelKey);
  const bench = lookupBenchmark(modelKey);

  // Merge benchmarks from BOTH sources — benchmark-registry has more
  // benchmark dimensions than the static evidence registry.
  const mergedBenchmarks: Record<string, number> = {};
  if (evidence.kind === "found") {
    Object.assign(mergedBenchmarks, evidence.record.benchmarks);
  }
  if (bench) {
    Object.assign(mergedBenchmarks, bench.benchmarks);
  }

  if (evidence.kind === "found") {
    return {
      ...evidence.record,
      benchmarks: mergedBenchmarks,
    };
  }

  if (bench) {
    return {
      provider,
      model,
      benchmarks: mergedBenchmarks,
      contextWindow: bench.contextWindow,
      inputCost: bench.inputCost,
      outputCost: bench.outputCost,
      availability: bench.availability,
      source: bench.source,
      date: bench.date,
      confidence: bench.confidence,
    };
  }

  // 3) Raw model data from provider.list / cache (lowest confidence).
  const raw = isRecord(rawModel) ? rawModel : {};
  const cost = isRecord(raw.cost) ? raw.cost : {};
  const limit = isRecord(raw.limit) ? raw.limit : {};
  return {
    provider,
    model,
    benchmarks: mergedBenchmarks,
    contextWindow: finiteNumber(limit.context),
    inputCost: finiteNumber(cost.input),
    outputCost: finiteNumber(cost.output),
    availability: evidenceAvailability(raw.status),
    source: "opencode provider.list",
    date: new Date().toISOString().slice(0, 10),
    confidence: 0.7,
  };
}

function variantsFromModel(rawModel: unknown): Effort[] | undefined {
  if (!isRecord(rawModel) || !isRecord(rawModel.variants)) return undefined;
  return Object.keys(rawModel.variants).sort() as Effort[];
}

/**
 * Converts the `ModelDataCache.providers` shape into `ConnectedProfileModel[]`
 * so the config hook can use the on-disk cache as fallback when the live
 * `provider.list()` call is unavailable or returns empty at config time.
 */
export function connectedModelsFromCache(
  providers: Record<string, Record<string, { variants?: string[] }>>,
): ConnectedProfileModel[] {
  const out: ConnectedProfileModel[] = [];
  for (const [provider, models] of Object.entries(providers)) {
    for (const [modelKey, info] of Object.entries(models)) {
      const fullId = `${provider}/${modelKey}`;
      const model = modelKey.includes("/") ? modelKey.split("/").pop()! : modelKey;
      out.push({
        provider,
        model,
        modelId: fullId,
        ladderRung: providerModelRung(provider, modelKey),
        variants: info.variants?.length ? (info.variants as Effort[]) : undefined,
        evidence: evidenceFromModel(provider, modelKey, info),
      });
    }
  }
  return out.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

export function connectedModelsFromProviderList(providerList: unknown[]): ConnectedProfileModel[] {
  const out: ConnectedProfileModel[] = [];
  for (const providerEntry of providerList) {
    if (!isRecord(providerEntry)) continue;
    const provider = providerEntry.id;
    if (typeof provider !== "string" || provider.length === 0) continue;
    if (!isRecord(providerEntry.models)) continue;
    for (const [model, rawModel] of Object.entries(providerEntry.models)) {
      if (model.length === 0) continue;
      out.push({
        provider,
        model,
        modelId: `${provider}/${model}`,
        ladderRung: providerModelRung(provider, model),
        variants: variantsFromModel(rawModel),
        evidence: evidenceFromModel(provider, model, rawModel),
      });
    }
  }
  return out.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/**
 * Design v4 (A6) — OpenCode task permissions use ordered wildcard matching;
 * the LAST matching rule wins. `*` is a greedy segment wildcard. Returns
 * true iff `agentName` is effectively ALLOWED under `taskPermission`.
 *
 * `taskPermission` may be the string `"allow"` (everything allowed), a
 * string `"deny"`/other (nothing), or a Record whose keys are wildcard
 * patterns evaluated in insertion order.
 */
export function wildcardMatch(pattern: string, agentName: string): boolean {
  if (pattern === agentName) return true;
  if (!pattern.includes("*")) return false;
  // Escape regex specials, then turn `*` into `.*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(agentName);
}

export function effectiveTaskAllowed(taskPermission: unknown, agentName: string): boolean {
  if (taskPermission === "allow") return true;
  if (!isRecord(taskPermission)) return false;
  let effective: unknown;
  for (const [pattern, decision] of Object.entries(taskPermission)) {
    if (!wildcardMatch(pattern, agentName)) continue;
    effective = decision;
  }
  return effective === "allow";
}

/**
 * Design v4 (A6) — propagate generated-alias permissions across every holder
 * agent. For each holder with a structured `permission.task`:
 *   - when the base agent is EFFECTIVELY allowed (ordered wildcard,
 *     last-match-wins), set an EXACT `task[alias] = "allow"` for every
 *     registered alias;
 *   - remove STALE exact `__mf_` entries that are no longer registered
 *     (keeps the task map tidy across reloads);
 *   - NEVER infer orchestrator permission from map presence — only an
 *     explicit allow rule grants the alias.
 *
 * Holders whose `task` is the string `"allow"` (allow-all) are left intact.
 */
export function propagateAliasPermissions(
  holders: Record<string, { permission?: { task?: unknown } }>,
  baseAgent: string,
  registeredAliases: readonly string[],
  staleAliases: readonly string[],
): void {
  const registered = new Set(registeredAliases);
  for (const holder of Object.values(holders)) {
    if (!holder || typeof holder !== "object") continue;
    const permission = holder.permission;
    if (!permission || typeof permission !== "object") continue;
    const task = (permission as { task?: unknown }).task;
    if (task === "allow") continue;
    if (!isRecord(task)) continue;
    // Remove stale exact __mf_ entries.
    for (const stale of staleAliases) {
      if (Object.prototype.hasOwnProperty.call(task, stale)) {
        delete (task as Record<string, unknown>)[stale];
      }
    }
    // Add exact alias allow only when the base is effectively allowed.
    if (effectiveTaskAllowed(task, baseAgent)) {
      for (const alias of registered) {
        if (!Object.prototype.hasOwnProperty.call(task, alias)) {
          (task as Record<string, unknown>)[alias] = "allow";
        }
      }
    } else {
      // Ensure no stale exact allow clings to a now-denied alias.
      for (const alias of registered) {
        if (
          Object.prototype.hasOwnProperty.call(task, alias) &&
          (task as Record<string, unknown>)[alias] === "allow"
        ) {
          delete (task as Record<string, unknown>)[alias];
        }
      }
    }
  }
}

export function generateProfilesForConfig(
  config: { agent?: Record<string, JsonishRecord | undefined> },
  connectedModels: readonly ConnectedProfileModel[],
  options: GenerateProfilesOptions = {},
): GeneratedProfileCatalog {
  // Defensive: a null/non-object config (or a non-array model list) must
  // never crash the config hook. Return an empty catalog gracefully.
  if (config === null || typeof config !== "object") return { byBase: {} };
  if (!Array.isArray(connectedModels)) return { byBase: {} };
  config.agent = config.agent ?? {};
  const agents = config.agent;
  const previouslyOwned = new Set(options.ownedAliases ?? []);
  for (const name of Object.keys(agents)) {
    if (previouslyOwned.has(name) || isManagedGeneratedAlias(name)) {
      previouslyOwned.add(name);
      delete agents[name];
    }
  }

  const prefixes = options.phasePrefixes ?? [...DEFAULT_PHASE_PREFIXES];
  const baseAgents = Object.entries(agents)
    .filter(([name, agent]) => isBasePhaseAgent(name, prefixes) && isRecord(agent))
    .map(([name, agent]) => [name, agent as JsonishRecord] as const)
    .sort(([a], [b]) => a.localeCompare(b));

  const catalog: GeneratedProfileCatalog = { byBase: {} };
  const maxPerBase = options.maxProfilesPerBase;
  for (const [baseAgent, baseConfig] of baseAgents) {
    const generated: GeneratedProfile[] = [];
    for (const model of connectedModels) {
      // Exclude models whose evidence marks them as "unavailable" — these
      // providers/models are known to be unusable (e.g. direct DeepSeek API
      // is not configured; only opencode-go routing works). Skipping them
      // here prevents them from entering the catalog and ever being selected
      // by forecast/fallback/profile generation.
      if (model.evidence?.availability === "unavailable") continue;

      const hasBenchmarks =
        model.evidence !== undefined &&
        Object.keys(model.evidence.benchmarks).length > 0;
      if (!hasBenchmarks) continue;

      const alias = generatedProfileAlias(baseAgent, model.modelId);
      generated.push({
        baseAgent,
        alias,
        provider: model.provider,
        model: model.model,
        modelId: model.modelId,
        ladderRung: model.ladderRung,
        evidence: model.evidence,
      });
    }

    // Always deduplicate by underlying model, picking the best provider.
    let profilesToRegister = generated;
    if (generated.length > 0) {
      // Pass the base agent as the phase signal so phase-specific factor
      // overrides fire (e.g. sdd-design/propose/spec zero the cost factor
      // for reasoning-heavy phases). Without this, cost stays weighted at
      // 0.25 and the cheapest model in the pool wins every phase — even
      // architecture decisions where cost should be irrelevant.
      const scored = scoreCandidatesAt(
        {
          contextSize: "medium",
          riskTier: "low",
          breadth: "moderate",
          modalities: [],
          phase: normalizePhase(baseAgent).phase,
        },
        generated.map(scoreInputForProfile),
        new Date(),
      );
      const scoreByModel = new Map(scored.map((c) => [c.model, c.score]));

      const CANONICAL_PROVIDERS = new Set([
        "deepseek", "anthropic", "openai", "google", "minimax", "zai",
        "mistral", "nvidia", "meta", "xai", "xiaomi",
      ]);
      const providerRank = (modelId: string): number => {
        const prov = modelId.split("/")[0];
        if (prov && CANONICAL_PROVIDERS.has(prov)) return 0;
        if (prov === "opencode-go" || prov === "zai-coding-plan") return 1;
        return 2;
      };

      // Deduplicate: keep best-scoring per canonical model name,
      // break ties by provider rank (canonical > opencode-go > routing).
      const canonicalName = (modelId: string) => {
        const bench = lookupBenchmark(modelId);
        if (bench) return bench.key;
        return modelId.split("/").pop() || modelId;
      };
      const bestPerModel = new Map<string, typeof generated[0]>();
      for (const profile of generated) {
        const name = canonicalName(profile.modelId);
        const existing = bestPerModel.get(name);
        if (!existing) {
          bestPerModel.set(name, profile);
        } else {
          const existingRank = providerRank(existing.modelId);
          const thisRank = providerRank(profile.modelId);
          if (thisRank < existingRank) {
            bestPerModel.set(name, profile);
          } else if (thisRank === existingRank) {
            const existingScore = scoreByModel.get(existing.modelId) ?? 0;
            const thisScore = scoreByModel.get(profile.modelId) ?? 0;
            if (thisScore > existingScore) bestPerModel.set(name, profile);
          }
        }
      }
      const deduped = [...bestPerModel.values()];
      deduped.sort((a, b) => (scoreByModel.get(b.modelId) ?? 0) - (scoreByModel.get(a.modelId) ?? 0));
      if (maxPerBase !== undefined && deduped.length > maxPerBase) {
        profilesToRegister = deduped.slice(0, maxPerBase);
      } else {
        profilesToRegister = deduped;
      }
    }

    for (const profile of profilesToRegister) {
      const alias = profile.alias;
      const generatedAgent = cloneJsonish(baseConfig);
      generatedAgent.model = profile.modelId;
      generatedAgent.mode = typeof generatedAgent.mode === "string" ? generatedAgent.mode : "subagent";
      generatedAgent.hidden = true;
      generatedAgent.description = `Generated model forecast profile for ${baseAgent} on ${profile.modelId}`;
      agents[alias] = generatedAgent;
    }

    // Configure the second model of the top selected profiles as the fallback of the first one
    if (profilesToRegister.length >= 2) {
      const firstProfile = profilesToRegister[0]!;
      const secondProfile = profilesToRegister[1]!;
      const fallbackAlias = `${firstProfile.alias}-fallback`;
      const fallbackAgent = cloneJsonish(baseConfig);
      fallbackAgent.model = secondProfile.modelId;
      fallbackAgent.mode = typeof fallbackAgent.mode === "string" ? fallbackAgent.mode : "subagent";
      fallbackAgent.hidden = true;
      fallbackAgent.description = `Fallback profile for ${baseAgent} (from ${firstProfile.modelId} to ${secondProfile.modelId})`;
      agents[fallbackAlias] = fallbackAgent;
    }

    catalog.byBase[baseAgent] = profilesToRegister;
  }

  // Design v4 (A6) — propagate EXACT alias allows under ordered wildcard
  // last-match-wins semantics, and remove only exact canonical managed aliases
  // left by previous generations. Stale collection is GLOBAL so processing
  // one base cannot evict another base's aliases from a shared task map.
  const allRegistered = new Set<string>();
  const perBaseRegistered: Record<string, string[]> = {};
  for (const [baseAgent, profiles] of Object.entries(catalog.byBase)) {
    const list: string[] = [];
    for (const profile of profiles) {
      list.push(profile.alias);
      if (profiles.length >= 2 && profile.alias === profiles[0]!.alias) {
        list.push(`${profile.alias}-fallback`);
      }
    }
    perBaseRegistered[baseAgent] = list;
    for (const alias of list) allRegistered.add(alias);
  }
  const staleAliases = collectStaleAliasKeys(agents, allRegistered);
  for (const alias of previouslyOwned) {
    if (!allRegistered.has(alias)) staleAliases.push(alias);
  }
  removeStaleAliasPermissions(agents, staleAliases);
  for (const [baseAgent, registeredAliases] of Object.entries(perBaseRegistered)) {
    propagateAliasPermissions(
      agents as unknown as Record<string, { permission?: { task?: unknown } }>,
      baseAgent,
      registeredAliases,
      [],
    );
  }
  if (options.ownedAliases !== undefined) {
    options.ownedAliases.clear();
    for (const alias of allRegistered) options.ownedAliases.add(alias);
  }
  return catalog;
}

function removeStaleAliasPermissions(
  agents: Record<string, JsonishRecord | undefined>,
  staleAliases: readonly string[],
): void {
  if (staleAliases.length === 0) return;
  for (const agent of Object.values(agents)) {
    if (!isRecord(agent)) continue;
    const permission = agent.permission;
    if (!isRecord(permission) || !isRecord(permission.task)) continue;
    for (const stale of staleAliases) delete permission.task[stale];
  }
}

/**
 * Design v4 (A6) — collects exact canonical managed task-permission keys that
 * are not in the current registered set. Prefix-only user keys are preserved.
 */
function collectStaleAliasKeys(
  agents: Record<string, JsonishRecord | undefined>,
  registered: Set<string>,
): string[] {
  const stale = new Set<string>();
  for (const agent of Object.values(agents)) {
    if (!isRecord(agent)) continue;
    const permission = agent.permission;
    if (!isRecord(permission)) continue;
    const task = permission.task;
    if (!isRecord(task)) continue;
    for (const key of Object.keys(task)) {
      if (isManagedGeneratedAlias(key) && !registered.has(key)) {
        stale.add(key);
      }
    }
  }
  return [...stale];
}

function scoreInputForProfile(profile: GeneratedProfile): ScoreCandidateInput {
  const modelKey = profile.modelId;
  const evidenceLookup = lookupEvidence(modelKey);
  const benchLookup = lookupBenchmark(modelKey);

  // Merge benchmarks from BOTH sources — benchmark-registry has more
  // benchmark dimensions than the static evidence registry.
  const mergedBenchmarks: Record<string, number> = {};

  if (evidenceLookup.kind === "found") {
    Object.assign(mergedBenchmarks, evidenceLookup.record.benchmarks);
  }
  if (benchLookup) {
    Object.assign(mergedBenchmarks, benchLookup.benchmarks);
  }

  if (evidenceLookup.kind === "found") {
    return {
      kind: "found",
      provider: profile.provider,
      model: profile.model,
      record: { ...evidenceLookup.record, benchmarks: mergedBenchmarks },
    };
  }
  if (profile.evidence !== undefined) {
    return {
      kind: "found",
      provider: profile.provider,
      model: profile.model,
      record: { ...profile.evidence, benchmarks: { ...profile.evidence.benchmarks, ...benchLookup?.benchmarks } },
    };
  }
  if (benchLookup) {
    return {
      kind: "found",
      provider: profile.provider,
      model: profile.model,
      record: {
        provider: profile.provider,
        model: profile.model,
        benchmarks: benchLookup.benchmarks,
        contextWindow: benchLookup.contextWindow,
        inputCost: benchLookup.inputCost,
        outputCost: benchLookup.outputCost,
        availability: benchLookup.availability,
        source: benchLookup.source,
        date: benchLookup.date,
        confidence: benchLookup.confidence,
      },
    };
  }
  return {
    kind: "missing",
    provider: profile.provider,
    model: profile.model,
  };
}

function taskContextInput(context: TaskContext): Parameters<typeof normalizeTaskContext>[0] {
  return {
    diffLines: context.diffLines,
    files: context.files,
    symbols: context.symbols,
    riskDomain: context.riskDomain,
    contextBreadth: context.contextBreadth,
    modality: context.modality,
    phase: context.phase,
  };
}

function baseAgentForGeneratedAlias(
  catalog: GeneratedProfileCatalog,
  subagentType: string,
): string | undefined {
  if (!isManagedGeneratedAlias(subagentType)) return undefined;
  for (const profiles of Object.values(catalog.byBase)) {
    for (const profile of profiles) {
      if (profile.alias === subagentType || `${profile.alias}-fallback` === subagentType) {
        return profile.baseAgent;
      }
    }
  }
  return undefined;
}

export function isGeneratedAliasRegistered(
  catalog: GeneratedProfileCatalog,
  ownedAliases: ReadonlySet<string>,
  alias: string,
  modelId: string,
  originalSubagentType: string,
): boolean {
  if (!ownedAliases.has(alias)) return false;
  const base = catalog.byBase[originalSubagentType] !== undefined
    ? originalSubagentType
    : baseAgentForGeneratedAlias(catalog, originalSubagentType) ??
      normalizePhase(originalSubagentType).phase;
  const profiles = catalog.byBase[base] ?? [];
  if (profiles.some((profile) => profile.alias === alias && profile.modelId === modelId)) {
    return true;
  }
  return profiles.length >= 2 &&
    alias === `${profiles[0]!.alias}-fallback` &&
    modelId === profiles[1]!.modelId;
}

export function createGeneratedProfileResolver(
  catalog: GeneratedProfileCatalog,
  options: { now?: Date; quarantine?: QuarantineBlocklist; logger?: Logger } = {},
): ResolveCandidates {
  return (deps): SelectCandidate[] => {
    // Profiles are only generated for BASE phase agents; escalation
    // variants (`sdd-design-alto`, `sdd-tasks-fallback`) are not keys in
    // `byBase`. Fall back to the normalized base phase so a variant
    // dispatch still resolves to its base phase's generated profiles.
    const generatedAliasBase = baseAgentForGeneratedAlias(catalog, deps.originalSubagentType);
    const allProfiles =
      catalog.byBase[deps.originalSubagentType] ??
      (generatedAliasBase ? catalog.byBase[generatedAliasBase] : undefined) ??
      catalog.byBase[normalizePhase(deps.originalSubagentType).phase] ??
      [];
    if (allProfiles.length === 0) return [];
    // 429-fallback (SDD change) — drop profiles whose `modelId` is
    // currently quarantined. Empty/absent dep is a no-op (byte-identical
    // to the pre-change output) so callers that never opt in see no
    // behaviour change.
    const liveProfiles = deps.liveModels === undefined
      ? allProfiles
      : allProfiles.filter((profile) => deps.liveModels!.some((model) => model === profile.modelId));
    if (liveProfiles.length === 0) return [];
    const quarantined = liveProfiles.length;
    const profiles = options.quarantine
      ? liveProfiles.filter((p) => !options.quarantine!.isBlocked(p.modelId))
      : liveProfiles;
    if (profiles.length === 0) {
      options.logger?.info(
        "generateProfiles",
        `no profiles for ${deps.originalSubagentType} (had ${quarantined}, all quarantined)`,
      );
      return [];
    }
    const signals = normalizeTaskContext(taskContextInput(deps.context));
    const scored = scoreCandidatesAt(
      signals,
      profiles.map(scoreInputForProfile),
      options.now ?? new Date(),
    );
    const scoreByModel = new Map(scored.map((candidate) => [candidate.model, candidate]));

    options.logger?.info(
      "generateProfiles",
      `resolved ${profiles.length} profiles for ${deps.originalSubagentType} — ` +
        `signals={size=${signals.contextSize}, risk=${signals.riskTier}, breadth=${signals.breadth}} ` +
        `top3: ${scored.slice(0, 3).map((c) => `${c.model}(s=${c.score.toFixed(2)},c=${c.confidence.toFixed(2)})`).join(", ")}`,
    );

    return profiles.map((profile) => {
      const scoredCandidate = scoreByModel.get(profile.modelId);
      return {
        subagent_type: profile.alias,
        model: profile.modelId,
        effort: "",
        confidence: scoredCandidate?.confidence ?? 0,
        evidence: scoredCandidate?.reasoning ?? `MISSING_EVIDENCE: ${profile.modelId}`,
        ladderRung: profile.ladderRung,
      };
    });
  };
}
