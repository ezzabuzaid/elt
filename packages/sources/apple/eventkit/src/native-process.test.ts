import assert from 'node:assert/strict';
import { test } from 'node:test';

import nativeProcess from './native-process.ts';

test(
  'native processes close on abort or iterator return and report stderr when they fail',
  {
    timeout: 10_000,
  },
  async () => {
    const waiting = ['-c', 'echo ready; exec sleep 60'];
    const controller = new AbortController();
    try {
      await using watching = nativeProcess.lines(
        '/bin/sh',
        waiting,
        controller.signal,
      );
      assert.deepEqual(await watching.next(), { value: 'ready', done: false });
      const pending = watching.next();
      controller.abort();
      assert.deepEqual(await pending, { value: undefined, done: true });
    } finally {
      controller.abort();
    }
    const stopped = nativeProcess.lines('/bin/sh', waiting);
    assert.equal((await stopped.next()).value, 'ready');
    assert.deepEqual(await stopped.return(undefined), {
      value: undefined,
      done: true,
    });
    await assert.rejects(
      nativeProcess
        .lines('/bin/sh', ['-c', 'echo native probe failure >&2; exit 3'])
        .next(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /native probe failure/);
        assert.equal(Reflect.get(error, 'stderr'), 'native probe failure\n');
        return true;
      },
    );
  },
);
