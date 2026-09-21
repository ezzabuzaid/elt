import { execFile, spawn } from 'node:child_process';
import { addAbortListener } from 'node:events';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export class OSA {
  async *watch(script: string, signal: AbortSignal): AsyncGenerator<string> {
    if (signal.aborted) return;
    const child = spawn(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let failure: Error | undefined;
    child.on('error', (error) => {
      failure = error;
    });
    const closed = new Promise<void>((resolve) =>
      child.once('close', () => resolve()),
    );
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    using _cancellation = addAbortListener(signal, () => {
      child.kill();
    });
    using lines = createInterface({ input: child.stdout });
    try {
      for await (const line of lines) yield line;
      await closed;
      if (failure) throw failure;
      if (!signal.aborted && child.exitCode !== 0)
        throw Object.assign(
          new Error(`Native watcher exited: ${stderr.trim()}`),
          {
            stderr,
            code: child.exitCode,
            signal: child.signalCode,
          },
        );
    } finally {
      child.kill();
      await closed;
    }
  }

  async execute(script: string): Promise<string> {
    // ponytail: buffers one batch up to 64 MiB; use chunked extraction for larger collections.
    const { stdout } = await execute(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
    );
    return stdout;
  }
}

export default new OSA();
