import type { FallbackResult } from "./fallback.js";

export type TaskRecoveryState =
  | "registered"
  | "awaiting-child"
  | "running-original"
  | "failure-claimed"
  | "fallback-running"
  | "fallback-ready"
  | "awaiting-original-settlement"
  | "completed-original"
  | "completed-fallback"
  | "fallback-exhausted"
  | "parent-recovery-enqueued"
  | "cancelled"
  | "cleaned";

export type ModelAttemptState =
  | "created"
  | "awaiting-session"
  | "running"
  | "retrying"
  | "waiting-permission"
  | "tool-running"
  | "abort-requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "cleaned";

export interface TrackedTask {
  callID: string;
  parentSessionID: string;

  originalSubagentType: string;
  generatedAlias: string;
  originalModel: string;
  prompt: string;

  state: TaskRecoveryState;

  createdAt: number;
  updatedAt: number;

  originalAttemptID: string;

  failure?: AttemptFailure;

  fallbackPromise?: Promise<FallbackResult>;
  fallbackResult?: FallbackResult;

  failureClaimedBy?: FailureSource;
  failureAuthoritative: boolean;

  afterHookSeen: boolean;
  userCancelled: boolean;
  parentRecoveryEnqueued: boolean;

  recoveryToken: string;

  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export interface ModelAttempt {
  id: string;
  taskCallID: string;

  kind: "original" | "fallback";
  sequence: 1 | 2 | 3;

  model: string;
  provider: string;
  agent: string;

  parentSessionID: string;
  sessionID?: string;

  state: ModelAttemptState;

  createdAt: number;
  boundAt?: number;
  firstActivityAt?: number;
  lastActivityAt: number;
  completedAt?: number;

  retryCount: number;
  retryWaitAccumulatedMs: number;

  waitingPermission: boolean;
  activeToolCallIDs: Set<string>;

  abortOrigin?: AbortOrigin;
  abortReason?: string;

  failure?: AttemptFailure;
  output?: string;

  watchdogGeneration: number;

  bindTimer?: ReturnType<typeof setTimeout>;
  firstActivityTimer?: ReturnType<typeof setTimeout>;
  inactivityTimer?: ReturnType<typeof setTimeout>;
  toolTimer?: ReturnType<typeof setTimeout>;
  hardTimer?: ReturnType<typeof setTimeout>;
}

export type AttemptFailureKind =
  | "rate_limit"
  | "model_not_configured"
  | "provider_error"
  | "empty_output"
  | "malformed_response"
  | "first_activity_timeout"
  | "inactivity_timeout"
  | "tool_execution_timeout"
  | "hard_timeout"
  | "session_create_timeout"
  | "session_create_failed"
  | "session_prompt_failed"
  | "session_deleted"
  | "unknown_retryable"
  | "unknown_terminal"
  | "user_cancelled"
  | "parent_cancelled";

export type FailureSource =
  | "tool-after"
  | "session-error"
  | "session-status"
  | "message-error"
  | "watchdog"
  | "sdk-rejection"
  | "response-parser";

export interface AttemptFailure {
  kind: AttemptFailureKind;
  source: FailureSource;

  code: string;
  message: string;

  retryable: boolean;
  authoritative: boolean;

  detectedAt: number;

  statusCode?: number;
  retryAfterMs?: number;
  rawExcerpt?: string;
}

export type AbortOrigin =
  | "plugin-authoritative-error"
  | "plugin-watchdog"
  | "plugin-cleanup"
  | "plugin-parent-recovery"
  | "user"
  | "external";
