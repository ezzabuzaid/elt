# Mail reads account settings from the system Accounts store

The `accounts` and `smtpServers` streams first read the settings through Mail's scripting with `osascript`. Scripting needs Automation access, and it can start Mail. The system Accounts store (`~/Library/Accounts/Accounts4.sqlite`) holds the same settings, and Full Disk Access opens it, as it opens the Mail store.

Thus the two streams read the Accounts store through `@workspace/sdk-apple-accounts`. Mail names the folder of each account, and the host of its mailbox URLs, with the account identifier of the store. The source joins each mailbox host to its account. A host that the store does not know, such as On My Mac, keeps the values that its URL gives. `smtpServers` has the identifier of the SMTP account as its key, and `accounts.properties.sendingServerId` refers to it.

The rules that read the store belong to the store, not to Mail: the parent fallbacks, the identity addresses, the incoming and outgoing servers, and the TLS rule. The SDK answers them, so an Accounts source uses the same rules. The source keeps only what Mail knows: the join from mailbox host to account, the record for a host that the store does not know, the folder path, and the shape of its records.

TLS: the `usesTls` value of the SDK, which Mail loads as `usesSsl`, reads `SSLEnabled` first, then `SSLIsDirect` only when it is true, then the `imapRequiresSSL` or `smtpRequiresSSL` of the parent. `SSLIsDirect` false means STARTTLS, not TLS off.

The Accounts store commits apart from Mail. While `accounts` or `smtpServers` is selected, a watch checks the `data_version` of the store each second. A commit there refreshes only those two streams. A Mail change refreshes them also, because it can add a mailbox host.

## Considered Options

- **Read the settings through Mail's scripting.** This needs Automation access, and it can start Mail.
- **Read the settings from the system Accounts store.** This option was selected.

## Consequences

- Mail needs only Full Disk Access, and it does not have to run.
- A store that the process cannot read fails only `accounts` and `smtpServers`, with `AccountsUnavailableError`. A watch does not watch that store, and it continues over the rest of Mail.
- A comparison with scripting on macOS 27 (Exchange, iCloud and Google) matched each account and SMTP field, except the server, port and SSL of an Exchange account, which scripting gives as none, 0 and false.
- A read-only connection to the store of the examined Mac saw five commits of `accountsd` in five minutes with no edit of an account. Thus the account streams refresh about one time each minute. A refresh with no changes writes no rows.
- The tests write a synthetic `Accounts4.sqlite`. No test mocks `osascript`.

## Sources

Commits 81e8c5a4 (read from the Accounts store), f117c608 (watch the Accounts store) and df9ed177 (the SDK answers the account rules).
