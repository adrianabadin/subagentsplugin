import { appendFile, mkdir } from "fs/promises";
import path from "path";
import { homedir } from "os";

const LOG_PATH = path.join(homedir(), ".cache", "opencode-model-forecast", "plugin.log");
const LOG_DIR = path.dirname(LOG_PATH);

export class Logger {
  constructor(
    readonly projectName: string,
    readonly projectDir: string,
    private readonly options: { verbose?: boolean } = {},
  ) {}

  private async write(level: "trace" | "info" | "warn" | "error", fn: string, message: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const line = `${timestamp} [model-forecast] [${this.projectName}] [${fn}] ${message}`;
    if (level === "error" || this.options.verbose === true) {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        // stderr write failure must never break the plugin.
      }
    }
    try {
      await mkdir(LOG_DIR, { recursive: true });
      await appendFile(LOG_PATH, `${line}\n`, "utf8");
    } catch {
      // File write failure must never break the plugin.
    }
  }

  trace(fn: string, message: string): void {
    void this.write("trace", fn, message);
  }

  info(fn: string, message: string): void {
    void this.write("info", fn, message);
  }

  warn(fn: string, message: string): void {
    void this.write("warn", fn, message);
  }

  error(fn: string, message: string): void {
    void this.write("error", fn, message);
  }
}

export function extractProjectInfo(input: Record<string, unknown> | undefined | null): {
  name: string;
  dir: string;
} {
  const dir =
    input !== undefined && input !== null && typeof (input as Record<string, unknown>).directory === "string"
      ? (input as Record<string, unknown>).directory as string
      : process.cwd();
  const name = path.basename(dir);
  return { name, dir };
}

/**
 * Backward-compatible stderr + file logger that works without a Logger
 * instance (no project context). Used by `logTransition` for test paths
 * and legacy callers that don't have a Logger reference.
 */
export function logLegacy(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} [model-forecast] ${message}`;
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // Best-effort.
  }
  const write = async (): Promise<void> => {
    try {
      await mkdir(LOG_DIR, { recursive: true });
      await appendFile(LOG_PATH, `${line}\n`, "utf8");
    } catch {
      // Best-effort.
    }
  };
  void write();
}
