import type { RecordDraft } from '@workspace/elt';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, accountId, nullableInstant } = teamsFields;

const properties = {
  accountId,
  id: { ...id, description: 'Teams’ ID for the entry.' },
  query: { ...id, description: 'What the user searched for.' },
  searchedAt: {
    ...nullableInstant,
    description: 'When the user last ran it.',
  },
} as const;

type Row = RecordDraft<typeof properties>;

export class SearchesStream extends TeamsStream<typeof properties, Row> {
  readonly name = 'searches';
  readonly primaryKey = ['accountId', 'id'];
  // Teams keeps only the latest searches and drops older ones without a
  // trace.
  override readonly emitsDeletes = undefined;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per search the user ran in Teams that the app has kept. Primary key accountId, id. Teams keeps only its latest searches; every search held stays.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: TeamsScan): readonly Row[] {
    return scan.clients.flatMap(({ account, searches }) =>
      searches.map((search) => ({ accountId: account.userId, ...search })),
    );
  }

  protected records(row: Row): Row[] {
    return [row];
  }
}
