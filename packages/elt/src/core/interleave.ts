// Up to concurrency generators run together, each value yielded as it
// arrives. A generator is asked for its next value only after the consumer
// took its last one, so whatever that value refers to stays valid until the
// consumer advances, whichever generator it came from.
export async function* interleave<T>(
  generators: readonly AsyncGenerator<T>[],
  concurrency: number,
): AsyncGenerator<T> {
  const waiting = [...generators];
  const reading = new Map<
    AsyncGenerator<T>,
    Promise<{ generator: AsyncGenerator<T>; result: IteratorResult<T> }>
  >();
  const next = (generator: AsyncGenerator<T>) =>
    reading.set(
      generator,
      generator.next().then((result) => ({ generator, result })),
    );
  const start = () => {
    const generator = waiting.shift();
    if (generator !== undefined) next(generator);
  };
  try {
    while (reading.size < concurrency && waiting.length > 0) start();
    while (reading.size > 0) {
      const { generator, result } = await Promise.race(reading.values());
      if (result.done) {
        reading.delete(generator);
        start();
        continue;
      }
      // Keep the yielding generator tracked so an early return closes it too.
      yield result.value;
      reading.delete(generator);
      next(generator);
    }
  } finally {
    for (const [generator, pending] of reading) {
      await pending.catch(() => undefined);
      await generator.return(undefined);
    }
    for (const generator of waiting) await generator.return(undefined);
  }
}
