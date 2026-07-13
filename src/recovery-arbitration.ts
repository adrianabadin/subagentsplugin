import type { TrackedTask } from "./recovery-types.js";

export type OriginalResultDecision =
  | { action: "preserve"; reason: "human_cancelled" }
  | { action: "await-fallback"; reason: "authoritative_failure" }
  | { action: "fallback"; reason: "fallback_success" }
  | { action: "original"; reason: "valid_original" }
  | { action: "ignore"; reason: "invalid_original" };

/** §6.4 precedence for the only hook allowed to mutate original output. */
export function decideOriginalResult(task: TrackedTask, output: unknown): OriginalResultDecision {
  if (task.userCancelled || task.state === "cancelled") return { action: "preserve", reason: "human_cancelled" };
  if (task.failureAuthoritative) return { action: "await-fallback", reason: "authoritative_failure" };
  if (task.fallbackResult?.status === "success") return { action: "fallback", reason: "fallback_success" };
  if (typeof output === "string" && output.trim().length > 0) return { action: "original", reason: "valid_original" };
  return { action: "ignore", reason: "invalid_original" };
}
