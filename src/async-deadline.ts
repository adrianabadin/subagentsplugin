export class DeadlineError extends Error {
  public readonly operation: string;
  public readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`[model-forecast] Operation '${operation}' exceeded deadline of ${timeoutMs}ms`);
    this.name = "DeadlineError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

export async function withDeadline<T>(
  operation: string,
  timeoutMs: number,
  run: () => Promise<T> | T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineError(operation, timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    const runPromise = Promise.resolve(run());
    const result = await Promise.race([runPromise, timeoutPromise]);
    if (timer) {
      clearTimeout(timer);
    }
    return result;
  } catch (error) {
    if (timer) {
      clearTimeout(timer);
    }
    throw error;
  }
}
