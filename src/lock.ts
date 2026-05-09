const chains = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  let resolveNext!: () => void;
  const next = new Promise<void>((resolve) => {
    resolveNext = resolve;
  });
  chains.set(key, next);
  try {
    await previous;
    return await fn();
  } finally {
    resolveNext();
    if (chains.get(key) === next) {
      chains.delete(key);
    }
  }
}
