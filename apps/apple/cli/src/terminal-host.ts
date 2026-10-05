import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppleHost } from '@workspace/connector-apple-connector/apple-connector';
import { type GoogleRequester, googleSession } from '@workspace/google-auth';

// The CLI as the host of the Apple apps: macOS grants access to the terminal
// that launched it, and Google content is read with the user's own OAuth
// client.
export class TerminalHost implements AppleHost {
  // The helper @workspace/macos-eventkit compiles into its dist.
  readonly eventKitHelper = fileURLToPath(
    new URL(
      'eventkit-helper',
      import.meta.resolve('@workspace/macos-eventkit'),
    ),
  );

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
        "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET for Calendar's Drive/Gmail attachments.",
      );
    return googleSession({
      clientId,
      clientSecret,
      scopes,
      directory: join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
        'context-compiler',
      ),
    });
  }
}
