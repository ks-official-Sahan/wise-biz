/** Rejects after `ms`. The losing promise gets a no-op catch so a late rejection is never unhandled. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${String(ms)} ms`));
    }, ms);
  });
  p.catch(() => undefined);
  return Promise.race([p, deadline]).finally(() => {
    clearTimeout(timer);
  });
}
