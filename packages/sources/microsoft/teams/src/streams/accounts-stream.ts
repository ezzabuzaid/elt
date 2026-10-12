import type { KeyValue, RecordDraft } from '@workspace/elt';
import type { TeamsClient } from '@workspace/sdk-microsoft-teams';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, textList } = teamsFields;

const properties = {
  id: {
    ...id,
    description:
      'The user’s Microsoft Entra object ID: the account signed in to Teams on this Mac.',
  },
  tenantId: {
    ...id,
    description: 'The Microsoft Entra ID of the organization signed in to.',
  },
  mri: {
    ...id,
    description:
      'The user’s Teams ID, 8:orgid:<id>, as messages and members name people (people.mri).',
  },
  tenantDomains: {
    ...textList,
    description: 'The organization’s verified domains.',
  },
} as const;

export class AccountsStream extends TeamsStream<
  typeof properties,
  TeamsClient
> {
  readonly name = 'accounts';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per work or school account signed in to the Teams app on this Mac. Primary key id. An account the app no longer keeps, such as one signed out of, stays.',
    properties,
    required: Object.keys(properties),
  } as const;

  override covers(
    scan: TeamsScan,
    key: Readonly<Record<string, KeyValue>>,
  ): boolean {
    return scan.keeps(key.id);
  }

  protected rows(scan: TeamsScan): readonly TeamsClient[] {
    return scan.clients;
  }

  protected records({
    account,
  }: TeamsClient): RecordDraft<typeof properties>[] {
    return [
      {
        id: account.userId,
        tenantId: account.tenantId,
        mri: account.mri,
        tenantDomains: [...account.tenantDomains],
      },
    ];
  }
}
