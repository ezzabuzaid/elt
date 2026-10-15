import { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import { type Choice, byId } from '@workspace/connector-apple-connector/choice';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import {
  type InstagramWebOptions,
  InstagramWebSource,
} from '@workspace/source-instagram-web/instagram-web-source';

// A followed account as Instagram's following list shows it: the username,
// then the name it shows.
const account: Choice['label'] = ({ username, fullName }) =>
  typeof fullName === 'string' && fullName !== ''
    ? `${String(username)} (${fullName})`
    : String(username);

function options({
  collectionIds,
  startAt,
  endAt,
}: ImportScope): InstagramWebOptions {
  return {
    ...(collectionIds === undefined ? {} : { profileIds: collectionIds }),
    ...(startAt === undefined ? {} : { startAt }),
    ...(endAt === undefined ? {} : { endAt }),
  };
}

export default class InstagramConnector extends AppleConnector {
  readonly datedBy = 'date posted';
  readonly fullDiskAccess = false;
  override readonly note =
    'Instagram has no Mac app, so the import reads instagram.com with the session of the browser you signed in to Instagram with. Pick the profiles among the accounts you follow; follow a profile on Instagram to add it. A long profile is complete after several hourly syncs.';
  protected readonly choices: readonly Choice[] = [
    {
      stream: 'following',
      scope: 'collectionIds',
      title: 'profiles',
      id: byId,
      label: account,
    },
  ];
  protected readonly unscoped = ['following'];
  protected readonly storeCopies = [];

  protected access(): string {
    return 'Sign in to Instagram in Dia, Google Chrome, Arc, Microsoft Edge or Brave. When macOS asks whether security may use the browser’s Safe Storage key, click Always Allow.';
  }

  protected source(scope: ImportScope): InstagramWebSource {
    return new InstagramWebSource(options(scope));
  }

  // An import that selects no profile reads every account the signed-in
  // account follows.
  protected override importSource(
    scope: ImportScope,
  ): Promise<InstagramWebSource> {
    return InstagramWebSource.connect(options(scope));
  }
}
