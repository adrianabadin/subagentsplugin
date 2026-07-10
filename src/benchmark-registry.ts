/**
 * Curated benchmark registry for major LLMs.
 *
 * Each entry maps to the canonical `provider/model` key used throughout
 * the forecast pipeline. Scores are normalised to [0, 1] where possible
 * (MT-Bench is [0,10] in raw form, normalised here to [0,1]).
 *
 * Sources: provider documentation, public leaderboards (LMSys, LiveCodeBench,
 * SWE-bench Verified), and published model cards. Date field reflects the
 * last verification timestamp.
 *
 * Models NOT in this registry fall through to the missing-evidence path
 * in scoring (score 0, confidence 0.1).
 */

export interface BenchmarkEntry {
  /** Canonical provider/model key, lowercased for lookup. */
  key: string;
  /** Normalised benchmark scores keyed by benchmark name. */
  benchmarks: Record<string, number>;
  /** Maximum context window in tokens (optional). */
  contextWindow?: number;
  /** USD per 1M input tokens (optional). */
  inputCost?: number;
  /** USD per 1M output tokens (optional). */
  outputCost?: number;
  /** USD per 1M input tokens for cache HITS, when the provider charges less for cached prompts (optional). */
  cacheHitCost?: number;
  /** Maximum output tokens per request (optional). */
  maxOutput?: number;
  /** Availability tag. */
  availability: "available" | "unknown" | "unavailable";
  /** Citation source. */
  source: string;
  /** ISO-8601 last-verified date. */
  date: string;
  /** Evidence confidence. */
  confidence: number;
}

const BENCHMARKS: readonly BenchmarkEntry[] = [
  // ── Anthropic ──────────────────────────────────────────────
  {
    key: "anthropic/claude-opus-4-7",
    benchmarks: { mmlu: 0.93, humaneval: 0.95, "swe-bench": 0.78, gpqa: 0.83, math: 0.91, bbh: 0.89, "mt-bench": 0.93, multineedle: 0.96 },
    contextWindow: 1_000_000, inputCost: 5, outputCost: 25,
    availability: "available", source: "anthropic.com/models", date: "2026-04-01", confidence: 0.95,
  },
  {
    key: "anthropic/claude-opus-4-6",
    benchmarks: { mmlu: 0.92, humaneval: 0.94, "swe-bench": 0.76, gpqa: 0.81, math: 0.90, bbh: 0.88, "mt-bench": 0.92, multineedle: 0.95 },
    contextWindow: 1_000_000, inputCost: 5, outputCost: 25,
    availability: "available", source: "anthropic.com/models", date: "2026-03-01", confidence: 0.95,
  },
  {
    key: "anthropic/claude-sonnet-4-6",
    benchmarks: { mmlu: 0.91, humaneval: 0.93, "swe-bench": 0.73, gpqa: 0.78, math: 0.88, bbh: 0.86, "mt-bench": 0.90, multineedle: 0.94 },
    contextWindow: 1_000_000, inputCost: 3, outputCost: 15,
    availability: "available", source: "anthropic.com/models", date: "2026-04-01", confidence: 0.95,
  },
  {
    key: "anthropic/claude-sonnet-4-5",
    benchmarks: { mmlu: 0.89, humaneval: 0.90, "swe-bench": 0.71, gpqa: 0.75, math: 0.86, bbh: 0.84, "mt-bench": 0.88, multineedle: 0.93 },
    contextWindow: 200_000, inputCost: 3, outputCost: 15,
    availability: "available", source: "anthropic.com/models", date: "2026-02-01", confidence: 0.95,
  },
  {
    key: "anthropic/claude-haiku-4-5",
    benchmarks: { mmlu: 0.81, humaneval: 0.82, "swe-bench": 0.55, gpqa: 0.68, math: 0.75, bbh: 0.72, "mt-bench": 0.79, multineedle: 0.88 },
    contextWindow: 200_000, inputCost: 1, outputCost: 5,
    availability: "available", source: "anthropic.com/models", date: "2026-04-01", confidence: 0.95,
  },
  {
    key: "anthropic/claude-fable-5",
    benchmarks: { mmlu: 0.94, humaneval: 0.96, "swe-bench": 0.82, gpqa: 0.86, math: 0.93, bbh: 0.92, "mt-bench": 0.95, multineedle: 0.97 },
    contextWindow: 1_000_000, inputCost: 10, outputCost: 50,
    availability: "unavailable", source: "anthropic.com/models", date: "2026-06-09", confidence: 0.96,
  },
  {
    key: "anthropic/claude-opus-4-8",
    benchmarks: { mmlu: 0.94, humaneval: 0.96, "swe-bench": 0.80, gpqa: 0.85, math: 0.92, bbh: 0.91, "mt-bench": 0.94, multineedle: 0.97 },
    contextWindow: 1_000_000, inputCost: 5, outputCost: 25,
    availability: "available", source: "anthropic.com/models", date: "2026-05-28", confidence: 0.96,
  },
  {
    key: "anthropic/claude-sonnet-5",
    benchmarks: { mmlu: 0.92, humaneval: 0.94, "swe-bench": 0.75, gpqa: 0.81, math: 0.89, bbh: 0.88, "mt-bench": 0.91, multineedle: 0.95 },
    contextWindow: 1_000_000, inputCost: 3, outputCost: 15,
    availability: "available", source: "anthropic.com/models", date: "2026-06-09", confidence: 0.96,
  },

  // ── Google / Gemini ────────────────────────────────────────
  {
    key: "google/gemini-2.5-pro",
    benchmarks: { mmlu: 0.88, humaneval: 0.91, "swe-bench": 0.74, gpqa: 0.76, math: 0.84, bbh: 0.82, "mt-bench": 0.86, multineedle: 0.98 },
    contextWindow: 1_000_000, inputCost: 1.25, outputCost: 10,
    availability: "available", source: "ai.google.dev", date: "2026-03-15", confidence: 0.90,
  },
  {
    key: "google/gemini-2.5-flash",
    benchmarks: { mmlu: 0.82, humaneval: 0.86, "swe-bench": 0.60, gpqa: 0.70, math: 0.78, bbh: 0.76, "mt-bench": 0.80, multineedle: 0.96 },
    contextWindow: 1_000_000, inputCost: 0.3, outputCost: 2.5,
    availability: "available", source: "ai.google.dev", date: "2026-03-15", confidence: 0.90,
  },
  {
    key: "google/gemini-3.1-pro",
    benchmarks: { mmlu: 0.90, humaneval: 0.92, "swe-bench": 0.75, gpqa: 0.80, math: 0.87, bbh: 0.85, "mt-bench": 0.88, multineedle: 0.98 },
    contextWindow: 1_000_000, inputCost: 2.0, outputCost: 12,
    availability: "available", source: "ai.google.dev", date: "2026-05-01", confidence: 0.90,
  },
  {
    key: "google/gemini-3-flash",
    benchmarks: { mmlu: 0.83, humaneval: 0.87, "swe-bench": 0.63, gpqa: 0.72, math: 0.80, bbh: 0.77, "mt-bench": 0.82, multineedle: 0.96 },
    contextWindow: 1_000_000, inputCost: 0.15, outputCost: 0.6,
    availability: "unavailable", source: "ai.google.dev", date: "2026-07-08", confidence: 0.90,
  },
  {
    key: "google/gemini-3.5-flash",
    benchmarks: { mmlu: 0.85, humaneval: 0.89, "swe-bench": 0.68, gpqa: 0.75, math: 0.83, bbh: 0.80, "mt-bench": 0.84, multineedle: 0.97 },
    contextWindow: 2_000_000, inputCost: 1.5, outputCost: 9.0,
    availability: "available", source: "ai.google.dev/pricing + /gemini-api/docs/models/gemini-3.5-flash", date: "2026-07-08", confidence: 0.92,
  },
  {
    key: "google/gemma-4-31b-it",
    benchmarks: { mmlu: 0.78, humaneval: 0.76, "swe-bench": 0.35, gpqa: 0.58, math: 0.62, bbh: 0.65, "mt-bench": 0.74, multineedle: 0.82 },
    contextWindow: 32_000, inputCost: 0, outputCost: 0,
    availability: "available", source: "ai.google.dev/gemma", date: "2026-04-01", confidence: 0.85,
  },

  // ── OpenAI ─────────────────────────────────────────────────
  {
    key: "openai/gpt-5.4",
    benchmarks: { mmlu: 0.90, humaneval: 0.92, "swe-bench": 0.73, gpqa: 0.79, math: 0.88, bbh: 0.86, "mt-bench": 0.89, multineedle: 0.94 },
    contextWindow: 400_000, inputCost: 2.5, outputCost: 10,
    availability: "available", source: "platform.openai.com", date: "2026-04-01", confidence: 0.88,
  },
  {
    key: "openai/gpt-5.4-mini",
    benchmarks: { mmlu: 0.85, humaneval: 0.89, "swe-bench": 0.65, gpqa: 0.73, math: 0.82, bbh: 0.80, "mt-bench": 0.83, multineedle: 0.90 },
    contextWindow: 400_000, inputCost: 0.3, outputCost: 1.2,
    availability: "available", source: "platform.openai.com", date: "2026-04-01", confidence: 0.88,
  },
  {
    key: "openai/gpt-5.5",
    benchmarks: { mmlu: 0.91, humaneval: 0.94, "swe-bench": 0.76, gpqa: 0.81, math: 0.90, bbh: 0.88, "mt-bench": 0.91, multineedle: 0.96 },
    contextWindow: 922_000, inputCost: 5, outputCost: 30,
    availability: "available", source: "platform.openai.com", date: "2026-04-23", confidence: 0.92,
  },
  {
    key: "openai/gpt-5.5-pro",
    benchmarks: { mmlu: 0.92, humaneval: 0.95, "swe-bench": 0.78, gpqa: 0.83, math: 0.91, bbh: 0.89, "mt-bench": 0.92, multineedle: 0.97 },
    contextWindow: 922_000, inputCost: 15, outputCost: 75,
    availability: "unavailable", source: "platform.openai.com", date: "2026-06-01", confidence: 0.88,
  },
  {
    key: "openai/gpt-4.1",
    benchmarks: { mmlu: 0.90, humaneval: 0.92, "swe-bench": 0.72, gpqa: 0.77, math: 0.86, bbh: 0.84, "mt-bench": 0.87, multineedle: 0.93 },
    contextWindow: 1_000_000, inputCost: 2, outputCost: 8,
    availability: "available", source: "platform.openai.com", date: "2026-02-10", confidence: 0.85,
  },
  {
    key: "openai/gpt-4.1-mini",
    benchmarks: { mmlu: 0.83, humaneval: 0.85, "swe-bench": 0.58, gpqa: 0.69, math: 0.76, bbh: 0.74, "mt-bench": 0.79, multineedle: 0.88 },
    contextWindow: 1_000_000, inputCost: 0.4, outputCost: 1.6,
    availability: "available", source: "platform.openai.com", date: "2026-02-10", confidence: 0.80,
  },
  {
    key: "openai/o4-mini",
    benchmarks: { mmlu: 0.87, humaneval: 0.91, "swe-bench": 0.70, gpqa: 0.76, math: 0.90, bbh: 0.82, "mt-bench": 0.85, multineedle: 0.84 },
    contextWindow: 200_000, inputCost: 1.1, outputCost: 4.4,
    availability: "available", source: "platform.openai.com", date: "2026-05-01", confidence: 0.85,
  },

  // ── DeepSeek ───────────────────────────────────────────────
  {
    key: "deepseek/deepseek-v4-pro",
    benchmarks: { mmlu: 0.91, humaneval: 0.93, "swe-bench": 0.72, gpqa: 0.78, math: 0.89, bbh: 0.86, "mt-bench": 0.89, multineedle: 0.90 },
    contextWindow: 1_000_000, inputCost: 0.435, outputCost: 0.87, cacheHitCost: 0.003625, maxOutput: 384_000,
    availability: "unavailable", source: "api-docs.deepseek.com/quick_start/pricing", date: "2026-07-08", confidence: 0.95,
  },
  {
    key: "deepseek/deepseek-v4-flash",
    benchmarks: { mmlu: 0.85, humaneval: 0.88, "swe-bench": 0.60, gpqa: 0.72, math: 0.79, bbh: 0.78, "mt-bench": 0.82, multineedle: 0.86 },
    contextWindow: 1_000_000, inputCost: 0.14, outputCost: 0.28,
    availability: "unavailable", source: "api-docs.deepseek.com", date: "2026-04-24", confidence: 0.90,
  },

  // ── NVIDIA Nemotron ────────────────────────────────────────
  {
    key: "nvidia/nemotron-3-super-120b-a12b",
    benchmarks: { mmlu: 0.87, humaneval: 0.89, "swe-bench": 0.65, gpqa: 0.72, math: 0.81, bbh: 0.80, "mt-bench": 0.84, multineedle: 0.88 },
    contextWindow: 128_000, inputCost: 0.5, outputCost: 2.0,
    availability: "available", source: "build.nvidia.com", date: "2026-04-01", confidence: 0.82,
  },
  {
    key: "nvidia/nemotron-3-nano-30b-a3b",
    benchmarks: { mmlu: 0.75, humaneval: 0.78, "swe-bench": 0.45, gpqa: 0.58, math: 0.62, bbh: 0.64, "mt-bench": 0.70, multineedle: 0.68 },
    contextWindow: 128_000, inputCost: 0.15, outputCost: 0.5,
    availability: "available", source: "build.nvidia.com", date: "2026-04-01", confidence: 0.80,
  },
  {
    key: "nvidia/nemotron-3-ultra-550b-a55b",
    benchmarks: { mmlu: 0.90, humaneval: 0.91, "swe-bench": 0.70, gpqa: 0.76, math: 0.85, bbh: 0.84, "mt-bench": 0.87, multineedle: 0.92 },
    contextWindow: 128_000, inputCost: 2, outputCost: 8,
    availability: "available", source: "build.nvidia.com", date: "2026-04-01", confidence: 0.82,
  },

  // ── Meta Llama ─────────────────────────────────────────────
  {
    key: "meta/llama-4-maverick-17b-128e",
    benchmarks: { mmlu: 0.80, humaneval: 0.83, "swe-bench": 0.50, gpqa: 0.65, math: 0.72, bbh: 0.74, "mt-bench": 0.78, multineedle: 0.80 },
    contextWindow: 128_000, inputCost: 0.2, outputCost: 0.6,
    availability: "available", source: "ai.meta.com/llama", date: "2026-04-01", confidence: 0.85,
  },

  // ── Mistral ────────────────────────────────────────────────
  {
    key: "mistral/mistral-medium-3.5",
    benchmarks: { mmlu: 0.86, humaneval: 0.87, "swe-bench": 0.62, gpqa: 0.72, math: 0.78, bbh: 0.78, "mt-bench": 0.83, multineedle: 0.85 },
    contextWindow: 256_000, inputCost: 1.5, outputCost: 6,
    availability: "available", source: "docs.mistral.ai", date: "2026-04-01", confidence: 0.85,
  },
  {
    key: "mistral/mistral-small-4-119b",
    benchmarks: { mmlu: 0.82, humaneval: 0.84, "swe-bench": 0.55, gpqa: 0.66, math: 0.72, bbh: 0.74, "mt-bench": 0.79, multineedle: 0.80 },
    contextWindow: 128_000, inputCost: 0.2, outputCost: 0.6,
    availability: "available", source: "docs.mistral.ai", date: "2026-04-01", confidence: 0.85,
  },

  // ── GLM (Z.AI) ─────────────────────────────────────────────
  {
    key: "zai/glm-5.2",
    benchmarks: { mmlu: 0.85, humaneval: 0.86, "swe-bench": 0.778, gpqa: 0.71, math: 0.78, bbh: 0.76, "mt-bench": 0.81, multineedle: 0.82 },
    contextWindow: 1_000_000, inputCost: 0.5, outputCost: 2,
    availability: "available", source: "docs.z.ai/guides/llm/glm-5", date: "2026-07-08", confidence: 0.85,
  },

  // ── MiniMax ────────────────────────────────────────────────
  {
    key: "minimax/minimax-m3",
    benchmarks: { mmlu: 0.84, humaneval: 0.86, "swe-bench": 0.59, gpqa: 0.68, math: 0.72, bbh: 0.74, "mt-bench": 0.80, multineedle: 0.84 },
    contextWindow: 1_000_000, inputCost: 0.3, outputCost: 1.2,
    availability: "available", source: "minimax.io/models/text/m3", date: "2026-06-01", confidence: 0.88,
  },
  {
    key: "minimax/minimax-m2.7",
    benchmarks: { mmlu: 0.80, humaneval: 0.82, "swe-bench": 0.48, gpqa: 0.63, math: 0.65, bbh: 0.70, "mt-bench": 0.76, multineedle: 0.78 },
    contextWindow: 205_000, inputCost: 0.15, outputCost: 0.6,
    availability: "available", source: "minimax.io", date: "2026-04-01", confidence: 0.85,
  },

  // ── Grok (xAI) ─────────────────────────────────────────────
  {
    key: "xai/grok-3-mini",
    benchmarks: { mmlu: 0.88, humaneval: 0.89, "swe-bench": 0.68, gpqa: 0.74, math: 0.85, bbh: 0.82, "mt-bench": 0.85, multineedle: 0.88 },
    contextWindow: 131_072, inputCost: 0.3, outputCost: 1.5,
    availability: "available", source: "x.ai/docs", date: "2026-04-01", confidence: 0.82,
  },

  // ── MiMo (Xiaomi) ──────────────────────────────────────────
  {
    key: "xiaomi/mimo-v2.5",
    benchmarks: { mmlu: 0.83, humaneval: 0.85, "swe-bench": 0.58, gpqa: 0.68, math: 0.74, bbh: 0.76, "mt-bench": 0.80, multineedle: 0.82 },
    contextWindow: 128_000, inputCost: 0.2, outputCost: 0.8,
    availability: "available", source: "mimo.xiaomi.com", date: "2026-04-01", confidence: 0.78,
  },
  {
    key: "xiaomi/mimo-v2.5-pro",
    benchmarks: { mmlu: 0.86, humaneval: 0.88, "swe-bench": 0.64, gpqa: 0.72, math: 0.80, bbh: 0.80, "mt-bench": 0.84, multineedle: 0.86 },
    contextWindow: 1_000_000, inputCost: 0.5, outputCost: 2,
    availability: "available", source: "huggingface.co/XiaomiMiMo/MiMo-V2.5-Pro", date: "2026-07-08", confidence: 0.85,
  },

  // ── Open-source (HF) key models ────────────────────────────
  {
    key: "hf/openai/gpt-oss-120b",
    benchmarks: { mmlu: 0.84, humaneval: 0.85, "swe-bench": 0.58, gpqa: 0.70, math: 0.78, bbh: 0.76, "mt-bench": 0.81, multineedle: 0.84 },
    contextWindow: 128_000, inputCost: 0.2, outputCost: 0.5,
    availability: "available", source: "huggingface.co/openai", date: "2026-04-01", confidence: 0.75,
  },

  // ── Provider aliases (opencode-go, zai-coding-plan, etc.) ───
  // These entries mirror canonical models for alternative providers.
  {
    key: "opencode-go/deepseek-v4-pro",
    benchmarks: { mmlu: 0.91, humaneval: 0.93, "swe-bench": 0.72, gpqa: 0.78, math: 0.89, bbh: 0.86, "mt-bench": 0.89, multineedle: 0.90 },
    contextWindow: 1_000_000, inputCost: 0.435, outputCost: 0.87, cacheHitCost: 0.003625, maxOutput: 384_000,
    availability: "available", source: "api-docs.deepseek.com/quick_start/pricing", date: "2026-07-08", confidence: 0.95,
  },
  {
    key: "opencode-go/deepseek-v4-flash",
    benchmarks: { mmlu: 0.85, humaneval: 0.88, "swe-bench": 0.60, gpqa: 0.72, math: 0.79, bbh: 0.78, "mt-bench": 0.82, multineedle: 0.86 },
    contextWindow: 1_000_000, inputCost: 0.14, outputCost: 0.28,
    availability: "available", source: "api-docs.deepseek.com", date: "2026-04-24", confidence: 0.90,
  },
  {
    key: "opencode-go/glm-5.2",
    benchmarks: { mmlu: 0.85, humaneval: 0.86, "swe-bench": 0.778, gpqa: 0.71, math: 0.78, bbh: 0.76, "mt-bench": 0.81, multineedle: 0.82 },
    contextWindow: 1_000_000, inputCost: 0.5, outputCost: 2,
    availability: "available", source: "docs.z.ai/guides/llm/glm-5", date: "2026-07-08", confidence: 0.85,
  },
  {
    key: "opencode-go/minimax-m3",
    benchmarks: { mmlu: 0.84, humaneval: 0.86, "swe-bench": 0.59, gpqa: 0.68, math: 0.72, bbh: 0.74, "mt-bench": 0.80, multineedle: 0.84 },
    contextWindow: 1_000_000, inputCost: 0.3, outputCost: 1.2,
    availability: "available", source: "minimax.io/models/text/m3", date: "2026-06-01", confidence: 0.88,
  },
  {
    key: "zai-coding-plan/glm-5.2",
    benchmarks: { mmlu: 0.85, humaneval: 0.86, "swe-bench": 0.778, gpqa: 0.71, math: 0.78, bbh: 0.76, "mt-bench": 0.81, multineedle: 0.82 },
    contextWindow: 1_000_000, inputCost: 0.5, outputCost: 2,
    availability: "available", source: "docs.z.ai/guides/llm/glm-5", date: "2026-07-08", confidence: 0.85,
  },
  {
    key: "google/antigravity-gemini-3.1-pro",
    benchmarks: { mmlu: 0.90, humaneval: 0.92, "swe-bench": 0.75, gpqa: 0.80, math: 0.87, bbh: 0.85, "mt-bench": 0.88, multineedle: 0.98 },
    contextWindow: 1_000_000, inputCost: 2.0, outputCost: 12,
    availability: "available", source: "ai.google.dev + antigravity route", date: "2026-07-08", confidence: 0.90,
  },
  {
    key: "google/antigravity-gemini-3.5-flash",
    benchmarks: { mmlu: 0.85, humaneval: 0.89, "swe-bench": 0.68, gpqa: 0.75, math: 0.83, bbh: 0.80, "mt-bench": 0.84, multineedle: 0.97 },
    contextWindow: 2_000_000, inputCost: 1.5, outputCost: 9.0,
    availability: "available", source: "ai.google.dev/pricing + antigravity route", date: "2026-07-08", confidence: 0.92,
  },
  {
    key: "google/antigravity-gemini-3-flash",
    benchmarks: { mmlu: 0.83, humaneval: 0.87, "swe-bench": 0.63, gpqa: 0.72, math: 0.80, bbh: 0.77, "mt-bench": 0.82, multineedle: 0.96 },
    contextWindow: 1_000_000, inputCost: 0.15, outputCost: 0.6,
    availability: "unavailable", source: "ai.google.dev + antigravity route", date: "2026-07-08", confidence: 0.90,
  },
];

/** Normalise a full model key for lookup: lowercase, trim, extract provider/model. */
export function normalizeKey(id: string): string {
  const slash = id.lastIndexOf("/");
  if (slash <= 0 || slash === id.length - 1) return id.trim().toLowerCase();
  return id.trim().toLowerCase();
}

/** Index by full lowercased key for O(1) lookup. */
const BY_KEY = new Map<string, BenchmarkEntry>(
  BENCHMARKS.map((e) => [e.key, e]),
);

/** Index by model name only (last segment). */
const BY_MODEL_NAME = new Map<string, BenchmarkEntry[]>();
for (const entry of BENCHMARKS) {
  const name = entry.key.slice(entry.key.lastIndexOf("/") + 1);
  const list = BY_MODEL_NAME.get(name);
  if (list) list.push(entry);
  else BY_MODEL_NAME.set(name, [entry]);
}

/**
 * Runtime validator for `BenchmarkEntry`. Used by both the loader
 * (`repo-data.ts`) and the CLI `update-data` subcommand so the
 * acceptance criteria for "valid benchmark entry" live in one place.
 *
 * Returns `true` ONLY when every required field is present and of the
 * correct type; partial entries are rejected.
 */
export function isBenchmarkEntry(value: unknown): value is BenchmarkEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.key !== "string" || v.key.length === 0) return false;
  if (v.benchmarks === null || typeof v.benchmarks !== "object" || Array.isArray(v.benchmarks)) {
    return false;
  }
  if (v.availability !== "available" && v.availability !== "unknown" && v.availability !== "unavailable") {
    return false;
  }
  if (typeof v.source !== "string" || v.source.length === 0) return false;
  if (typeof v.date !== "string" || v.date.length === 0) return false;
  if (typeof v.confidence !== "number" || !Number.isFinite(v.confidence)) return false;
  return true;
}

/**
 * Repo-local override entries. When set, lookups consult this map first;
 * merge is replace-by-key (one repo-local entry overrides one compiled
 * entry by exact key match). `setRepoLocal(null)` clears the override.
 *
 * The compiled registry shape is kept unchanged — `getBenchmarkRegistry()`
 * returns the EFFECTIVE view (compiled + repo-local overlay) so callers
 * like `resolveModelGroup` see overrides too.
 */
let repoLocal: ReadonlyMap<string, BenchmarkEntry> | null = null;

export function setRepoLocal(entries: readonly BenchmarkEntry[] | null): void {
  if (entries === null) {
    repoLocal = null;
    return;
  }
  const map = new Map<string, BenchmarkEntry>();
  for (const entry of entries) {
    if (typeof entry.key !== "string" || entry.key.length === 0) continue;
    map.set(entry.key, entry);
  }
  repoLocal = map;
}

/** Read-only view of the currently loaded repo-local override (test helper). */
export function getRepoLocal(): readonly BenchmarkEntry[] {
  if (repoLocal === null) return [];
  return [...repoLocal.values()];
}

/**
 * Effective registry: compiled entries with repo-local entries replacing
 * any matching key. Returned in deterministic order: repo-local keys
 * replace their compiled counterpart; order otherwise follows `BENCHMARKS`.
 */
function getEffectiveRegistry(): readonly BenchmarkEntry[] {
  if (repoLocal === null || repoLocal.size === 0) return BENCHMARKS;
  const overlay = repoLocal;
  const out: BenchmarkEntry[] = [];
  const seen = new Set<string>();
  for (const compiled of BENCHMARKS) {
    const override = overlay.get(compiled.key);
    out.push(override ?? compiled);
    if (override) seen.add(compiled.key);
  }
  for (const [key, entry] of overlay) {
    if (!seen.has(key)) out.push(entry);
  }
  return out;
}

/**
 * Look up a benchmark entry by canonical key (case-insensitive).
 *
 * Fallback strategy for routing providers:
 *   1. Exact match: "deepseek/deepseek-v4-flash" → ✓
 *   2. Strip routing provider prefix ("openrouter/anthropic/claude-opus-4-8" → "anthropic/claude-opus-4-8") → ✓
 *   3. Match by model name only ("vercel/deepseek-v4-flash" → "deepseek-v4-flash" → deepseek/deepseek-v4-flash) → ✓
 */
export function lookupBenchmark(id: string): BenchmarkEntry | undefined {
  const normalised = normalizeKey(id);
  if (normalised.length === 0) return undefined;

  // 0) Repo-local override (replace-by-key, highest precedence).
  if (repoLocal !== null) {
    const direct = repoLocal.get(normalised);
    if (direct) return direct;
  }

  // 1) Exact match
  const direct = BY_KEY.get(normalised);
  if (direct) return direct;

  // 2) Multi-segment: strip first provider segment
  const parts = normalised.split("/");
  if (parts.length > 2) {
    const stripped = parts.slice(1).join("/");
    if (repoLocal !== null) {
      const override = repoLocal.get(stripped);
      if (override) return override;
    }
    const match = BY_KEY.get(stripped);
    if (match) return match;
  }

  // 3) Match by model name only (last segment)
  //    "vercel/deepseek-v4-flash" → "deepseek-v4-flash" → deepseek/deepseek-v4-flash
  const modelName = parts[parts.length - 1];
  const candidates = BY_MODEL_NAME.get(modelName);
  if (candidates && candidates.length > 0) {
    // Prefer canonical (non-opencode-go) entry when multiple match
    const canonical = candidates.find((e) => !e.key.startsWith("opencode-go/"));
    return canonical ?? candidates[0];
  }

  // 4) Repo-local fallback by model name (case where override uses a
  //    different provider prefix than the lookup key).
  if (repoLocal !== null) {
    const overlay = repoLocal;
    for (const entry of overlay.values()) {
      if (entry.key.slice(entry.key.lastIndexOf("/") + 1) === modelName) {
        return entry;
      }
    }
  }

  return undefined;
}

/** Returns the full benchmark registry for iteration. */
export function getBenchmarkRegistry(): readonly BenchmarkEntry[] {
  return getEffectiveRegistry();
}
