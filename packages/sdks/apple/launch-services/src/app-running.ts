import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

// Whether macOS has an app with this bundle identifier running, as Launch
// Services lists it.
export async function appRunning(bundle: string): Promise<boolean> {
  const { stdout } = await execFile('/usr/bin/lsappinfo', [
    'info',
    '-only',
    'pid',
    '-app',
    bundle,
  ]);
  // Older macOS prints `"pid"=123`; macOS 27 prints `pid = 123`. An app that
  // is not running prints no pid.
  return /\bpid"?\s*=\s*\d+/.test(stdout);
}
