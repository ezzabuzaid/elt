import { execFile as execFileCallback } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

// The system TCC store exists on every Mac and only Full Disk Access lists
// it. A store that fails to open cannot tell a denial from a missing file;
// this directory can, so `EPERM` here means the process lacks the access.
const protectedDirectory = '/Library/Application Support/com.apple.TCC';

export async function hasFullDiskAccess(): Promise<boolean> {
  try {
    await readdir(protectedDirectory);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

// macOS has no prompt for Full Disk Access; the closest is opening its list
// in System Settings for the user to turn the app on.
export async function openFullDiskAccessSettings(): Promise<void> {
  await execFile('/usr/bin/open', [
    'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  ]);
}
