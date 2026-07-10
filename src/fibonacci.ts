/**
 * Returns the nth Fibonacci number (fib(0) = 0, fib(1) = 1).
 * Iterative O(n) time, O(1) space.
 *
 * @throws {RangeError} if n < 0.
 */
export function fibonacci(n: number): number {
  if (n < 0) {
    throw new RangeError(`fibonacci(${n}): n must be >= 0`);
  }
  if (n === 0) return 0;
  if (n === 1) return 1;
  let a = 0;
  let b = 1;
  for (let i = 2; i <= n; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return b;
}
