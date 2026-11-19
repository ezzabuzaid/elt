import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export class OSA {
  // A script that throws fails with the error that osascript gives for it,
  // such as "Cannot read PDF (-2700)", and keeps node's error, with the
  // command and its whole stderr, as the cause: a reader of the failure needs
  // the reason, not the script and the paths in it. Any other failure, such
  // as the timeout, is node's own.
  async execute(script: string): Promise<string> {
    try {
      // ponytail: buffers one batch up to 64 MiB; use chunked extraction for larger collections.
      const { stdout } = await execute(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', '-e', script],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
      );
      return stdout;
    } catch (error) {
      const reason = executionError(error);
      if (reason === undefined) throw error;
      throw new Error(reason, { cause: error });
    }
  }
}

// The line of osascript's stderr that tells why a script failed, without
// the "Error: " that JavaScript puts before the message of each Error, or
// undefined when osascript gave none.
function executionError(error: unknown): string | undefined {
  const stderr: unknown = Object(error).stderr;
  if (typeof stderr !== 'string') return undefined;
  return /execution error: (?:Error: )*(.+)$/m.exec(stderr)?.[1]?.trim();
}

export default new OSA();
