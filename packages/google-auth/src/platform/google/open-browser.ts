import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Other environments provide their own googleSession openBrowser callback.
export async function openBrowser(url: string): Promise<void> {
  const target = new URL(url);
  if (target.protocol !== 'https:')
    throw new TypeError('Only an https consent link is opened');
  if (process.platform !== 'darwin')
    throw new Error(
      'Provide a googleSession openBrowser callback on this platform',
    );
  await promisify(execFile)('open', [target.href]);
}
