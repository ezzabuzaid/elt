import { execFileSync } from 'node:child_process';
import { basename, extname } from 'node:path';
import type { AppleHost } from 'apple/apps/apple-app';
import {
  type GoogleRequester,
  googleSession,
  grantDirectory,
} from 'google-auth';

// The CLI as the host of the Apple apps: macOS grants access to the terminal
// that launched it, and Google content is read with the user's own OAuth
// client.
export class TerminalHost implements AppleHost {
  // The app macOS asks for access on behalf of: the one that launched this
  // process. TERM_PROGRAM cannot name it; cmux, for one, reports ghostty.
  // Spotlight answers only when guidance is shown.
  get grantee(): string {
    const bundle = process.env.__CFBundleIdentifier;
    if (bundle !== undefined && /^[\w.-]+$/.test(bundle))
      try {
        const [path] = execFileSync(
          '/usr/bin/mdfind',
          [`kMDItemCFBundleIdentifier == '${bundle}'`],
          { encoding: 'utf8', timeout: 5_000 },
        ).split('\n');
        if (path) return basename(path, extname(path));
      } catch {
        // Spotlight is unavailable: name the app generically.
      }
    return 'your terminal app';
  }

  google(scopes: readonly string[]): Promise<GoogleRequester> {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret)
      throw new Error(
        `Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET for Calendar's Drive/Gmail attachments; grants are stored under ${grantDirectory()}.`,
      );
    return googleSession({ clientId, clientSecret, scopes });
  }
}
