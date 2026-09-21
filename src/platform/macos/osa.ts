import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export class OSA {
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
