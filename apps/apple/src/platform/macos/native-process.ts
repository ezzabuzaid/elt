import { spawn } from 'node:child_process';
import { addAbortListener } from 'node:events';
import { createInterface } from 'node:readline';

export class NativeProcess {
  // Each stdout line of the process as it arrives. A non-zero exit rejects with
  // the process's stderr, unless the signal stopped it.
  async *lines(
    file: string,
    args: readonly string[],
    signal = new AbortController().signal,
  ): AsyncGenerator<string> {
    if (signal.aborted) return;
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
        throw Object.assign(new Error(`${file} exited: ${stderr.trim()}`), {
          stderr,
          code: child.exitCode,
          signal: child.signalCode,
        });
    } finally {
      child.kill();
      await closed;
    }
  }
}

export default new NativeProcess();
