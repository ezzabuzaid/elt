import { AppleNotesStream } from './apple-notes-stream.ts';

export type Account = {
  id: string;
  name: string;
  upgraded: boolean;
};

export class AccountsStream extends AppleNotesStream<Account> {
  readonly name = 'accounts';
  readonly jsonSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      upgraded: { type: 'boolean' },
    },
    required: ['id', 'name', 'upgraded'],
  } as const;

  protected readonly script = `
      app.accounts().map(account => ({
        id: account.id(),
        name: account.name(),
        upgraded: account.upgraded()
      }))
  `;

  protected validate(accounts: unknown): Account[] {
    if (
      !Array.isArray(accounts) ||
      !accounts.every(
        (account) =>
          account !== null &&
          typeof account === 'object' &&
          !Array.isArray(account) &&
          typeof account.id === 'string' &&
          typeof account.name === 'string' &&
          typeof account.upgraded === 'boolean',
      )
    )
      throw new TypeError('Notes returned an unexpected account format');

    return accounts;
  }
}
