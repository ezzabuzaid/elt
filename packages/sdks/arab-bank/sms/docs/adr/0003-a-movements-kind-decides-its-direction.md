# A movement's kind decides its direction

ipay's movement has a `kind` and a `direction`, stored side by side. Every kind but one has one direction: a purchase is always a debit and a salary is always a credit. `cliq` is the exception: the bank sends a CliQ payment that went out and one that came in. With both fields stored, `{ kind: 'salary', direction: 'debit' }` can be built, though no text tells of it.

Thus `cliq` splits into `cliq_out` and `cliq_in`, as `transfer_out` and `transfer_in` already do, and `direction` is a getter that the kind decides. The amount is never signed.

| Kind                                                                         | Direction |
| ---------------------------------------------------------------------------- | --------- |
| `purchase`, `withdrawal`, `cliq_out`, `bill`, `card_payment`, `transfer_out` | `debit`   |
| `cliq_in`, `card_credit`, `transfer_in`, `salary`, `deposit`, `reversal`     | `credit`  |

## Considered Options

- **Keep `kind` and `direction` as two stored fields.** A wrong pair can be built.
- **A signed amount, as Plaid does** (positive when money moves out). The sign repeats what the kind says, and a reader that sums across currencies must still read the currency.
- **The kind decides the direction.** This option was selected.

## Consequences

- ipay's `cliq` becomes `cliq_out` or `cliq_in` at the migration, and its `bank_charges` column descriptions list the new kinds.
- A new kind needs one row in this table.
