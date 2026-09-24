import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Shows the consent link and, on macOS, opens it. The link is always printed so
 * a headless or remote session can still finish sign-in by hand.
 */
export async function openBrowser(url: string): Promise<void> {
  const target = new URL(url);
  if (target.protocol !== 'https:')
    throw new TypeError('Only an https consent link is opened');
  console.error(`Connect Google by opening:\n  ${target.href}`);
  if (process.platform !== 'darwin') return;
  try {
    await promisify(execFile)('open', [target.href]);
  } catch {
    console.error('Could not open a browser; use the link above.');
  }
}
