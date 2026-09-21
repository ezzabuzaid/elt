import { AppleRemindersStream } from './apple-reminders-stream.ts';

export type Account = {
  id: string;
  name: string;
};

export class AccountsStream extends AppleRemindersStream<Account> {
  readonly name = 'accounts';
  readonly jsonSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
    },
    required: ['id', 'name'],
  } as const;

  protected readonly script = `
    app.accounts().map(account => {
      const properties = account.properties();
      return { id: properties.id, name: properties.name };
    })
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
          typeof account.name === 'string',
      )
    )
      throw new TypeError('Reminders returned an unexpected account format');
    return accounts;
  }
}
