import type { SyncMode } from '@workspace/elt';
import type { FollowedAccount } from '@workspace/sdk-instagram-web';

import { fields } from '../fields.ts';
import type { ReadContext } from '../instagram-stream.ts';
import { type Snapshot, SnapshotStream } from '../snapshot-stream.ts';

const { id, text, flag } = fields;

const properties = {
  id: { ...id, description: 'The account’s Instagram user id.' },
  username: {
    ...text,
    description: 'The account’s username, as in instagram.com/<username>.',
  },
  fullName: {
    ...text,
    description: 'The name the account shows; empty when it set none.',
  },
  isPrivate: {
    ...flag,
    description: 'Only the account’s followers see its posts.',
  },
  isVerified: { ...flag, description: 'Instagram verified the account.' },
} as const;

// The accounts the signed-in account follows: the profiles an import can
// be narrowed to.
export class FollowingStream extends SnapshotStream<typeof properties> {
  readonly name = 'following';
  override readonly partitionKey = undefined;
  // Setup lists the accounts with one full read.
  override readonly supportedSyncModes: readonly SyncMode[] = [
    'full_refresh',
    'incremental',
  ];
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per account the Instagram account signed in to in the browser follows. Primary key id. An account it unfollows is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected async scan({
    run,
    signal,
  }: ReadContext): Promise<Snapshot<typeof properties>> {
    const accounts: FollowedAccount[] = [];
    let next: string | null = null;
    do {
      const page = await run.web.following(next, signal);
      accounts.push(...page.items);
      next = page.next;
    } while (next !== null);
    return {
      records: accounts.map((account) => ({
        id: account.pk,
        username: account.username,
        fullName: account.full_name,
        isPrivate: account.is_private,
        isVerified: account.is_verified,
      })),
    };
  }
}
