import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const bundle = 'com.apple.Notes';

// Only Notes.app syncs iCloud notes on the Mac; while it is closed the store
// holds its last synced state. Launching it hidden and in the background
// syncs without a window or taking focus. A running Notes is left as it is,
// since `open -j` would hide a window the user has open.
export async function launchNotesHidden(): Promise<boolean> {
  const { stdout } = await execFile('/usr/bin/lsappinfo', [
    'info',
    '-only',
    'pid',
    '-app',
    bundle,
  ]);
  if (/"pid"=\d+/.test(stdout)) return false;
  await execFile('/usr/bin/open', ['-g', '-j', '-b', bundle]);
  return true;
}
