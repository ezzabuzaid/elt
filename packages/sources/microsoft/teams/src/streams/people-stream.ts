import type { RecordDraft } from '@workspace/elt';
import type { TeamsPerson } from '@workspace/sdk-microsoft-teams';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, accountId, nullableText } = teamsFields;

const properties = {
  accountId,
  mri: {
    ...id,
    description:
      'The person’s Teams ID, 8:orgid:<objectId>, or a bot’s, 28:<id>: what messages, members and calls name them by.',
  },
  objectId: {
    ...nullableText,
    description: 'Their Microsoft Entra object ID.',
  },
  type: { ...nullableText, description: 'ADUser for a person, BOT for a bot.' },
  displayName: { ...nullableText, description: 'Their name.' },
  givenName: { ...nullableText, description: 'Their first name.' },
  surname: { ...nullableText, description: 'Their last name.' },
  email: { ...nullableText, description: 'Their email address.' },
  userPrincipalName: {
    ...nullableText,
    description: 'The name they sign in with.',
  },
  jobTitle: { ...nullableText, description: 'Their job title.' },
  department: { ...nullableText, description: 'Their department.' },
  companyName: { ...nullableText, description: 'Their company.' },
  officeLocation: { ...nullableText, description: 'Their office.' },
  userLocation: {
    ...nullableText,
    description: 'Where they work, as their organization records it.',
  },
  tenantName: {
    ...nullableText,
    description: 'The organization they belong to.',
  },
  userType: {
    ...nullableText,
    description: 'Member, or Guest for someone from outside.',
  },
} as const;

type Row = { readonly accountId: string; readonly person: TeamsPerson };

export class PeopleStream extends TeamsStream<typeof properties, Row> {
  readonly name = 'people';
  readonly primaryKey = ['accountId', 'mri'];
  // The app looks people up as it needs them and drops them from its cache
  // without a trace, so a person gone from it was not deleted.
  override readonly emitsDeletes = undefined;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per person or bot the app has looked up in the directory, with what the directory said then. Primary key accountId, mri. The app keeps only people it has looked up lately; everyone it has held stays.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: TeamsScan): readonly Row[] {
    return scan.clients.flatMap(({ account, people }) =>
      people.map((person) => ({ accountId: account.userId, person })),
    );
  }

  protected records({
    accountId,
    person,
  }: Row): RecordDraft<typeof properties>[] {
    return [{ accountId, ...person }];
  }
}
