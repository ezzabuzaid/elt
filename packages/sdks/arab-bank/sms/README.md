> **Design, decided; build parked.** This folder is the API on paper of `@eltjs/sdk-arab-bank-sms` (backlog #3668). It has no code, no `package.json` and no tsconfig. ADRs 0001 to 0004 are the decisions (2026-11-17). Ezz parked the build the same day.

# Arab Bank SMS

Arab Bank sends a text for each movement of its customers' accounts: a card purchase, a withdrawal, a CliQ payment, a transfer, a salary. It also sends texts that tell of no movement: one-time passwords, refused attempts, statements, sign-in alerts and offers. A caller has one of these texts and the time that it was sent, and wants to know what it tells. `ArabBankText.read` gives a reading of the text: a movement, a notice, or unrecognized. The SDK knows the bank's templates. It does not know where the texts are stored.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

```ts
import { ArabBankText } from '@eltjs/sdk-arab-bank-sms';

const reading = ArabBankText.read(
  'JO تم قيد حركة شراء من حسابكم 500*0145 من CAREEM بمبلغ JOD 8.920 بتاريخ 04/03/2026 12:00 .الرصيد JOD 900.000',
  Temporal.Instant.from('2026-03-04T09:00:00Z'),
);
if (reading.type === 'movement') {
  reading.kind; // 'purchase'
  reading.direction; // 'debit'
  reading.counterparty; // 'CAREEM'
  reading.amount; // '8.920'
  reading.currency; // 'JOD'
  reading.bookedOn; // Temporal.PlainDate 2026-03-04
}
```

Which texts to read, and what to do with each reading, belong to the caller.

## Read a text

- `ArabBankText.read(text, sentAt)` takes the text as Messages stores it and the instant that it was sent. It gives one `Reading`:
  - `Movement`: the text tells of one movement of an account.
  - `Notice`: the text is one of the bank's known texts that tell of no movement. `notice.kind` says which.
  - `Unrecognized`: the text matches no template that the SDK knows. See [ADR 0002](./docs/adr/0002-every-text-gets-a-reading-so-a-new-template-is-never-silent.md).
- `read` never throws for a text. A text from another sender is unrecognized.
- `ArabBankText.senders` is the names that Messages gives the bank's texts: `Arab Bank`, and `ArabBank` until March 2024. The caller selects its texts with them.

## A movement

| Field          | What it is                                                                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`         | `purchase`, `withdrawal`, `cliq_out`, `cliq_in`, `bill`, `card_payment`, `card_credit`, `transfer_out`, `transfer_in`, `salary`, `deposit` or `reversal`                                             |
| `direction`    | `debit` or `credit`. The kind decides it. See [ADR 0003](./docs/adr/0003-a-movements-kind-decides-its-direction.md).                                                                                 |
| `counterparty` | Who the money went to or came from, as the text names them: a merchant, an ATM, a CliQ recipient or an account. Absent when the text names none.                                                     |
| `amount`       | The amount as the bank writes it, a decimal string without thousands separators, never signed. See [ADR 0004](./docs/adr/0004-the-amount-is-the-decimal-the-bank-wrote-and-the-day-is-the-banks.md). |
| `currency`     | The ISO 4217 code that the text states, such as `JOD` or `USD`.                                                                                                                                      |
| `bookedOn`     | The day that the bank books the movement on, on the bank's clock (Asia/Amman): the day that the text states, else the day that it was sent.                                                          |

## What happens underneath

| Call                          | What happens                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ArabBankText.read(text, at)` | Each movement template, then each notice template, is tried in order. The first that matches gives the reading. No two templates match the same text (`elt` AGENTS.md, "Fix the overlap, not the order"). |
| an amount                     | `JOD 0.731`, `JOD3.749`, `900 JOD` and `88.000JOD` all give the amount and its currency.                                                                                                                  |
| a stated day                  | `بتاريخ dd/mm/yyyy`, `بتاريخ dd/mm` and `on dd-Mon-yyyy`. A day without its year is the latest such day on or before the day the text was sent.                                                           |

## The texts it reads

Measured on 2026-11-17 over all 6,584 Arab Bank texts in one user's `chat.db` (2019-04 to 2026-11), with each body decoded:

- ipay's parser, the copy that this SDK starts from, read 5,979 as movements. The proactive rules read 2,460 purchases and missed 1,642: 1,315 in the form `JOD165` (until 2025-02-06) and 327 from the sender `ArabBank` (until 2024-03-23).
- 605 texts read as no movement. Most are notices. Two groups are movements that no copy reads: an English CliQ debit, `JOD… has been debited from … to … as CliQ transfer` (sent since at least 2026-11-13, context-compiler #4543), and an older incoming transfer, `حوالة بمبلغ … JOD لحساب` (until 2024-03).

## Errors

`read` throws no error for a text. `sentAt` must be a `Temporal.Instant`; the types refuse anything else.

## The same concepts in other systems

| This package                          | Other systems                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Movement                              | Plaid's transaction; the bank's own word for it, حركة                                     |
| `transfer_in`, `transfer_out`         | Plaid's `TRANSFER_IN` and `TRANSFER_OUT` personal finance categories                      |
| `direction` with an unsigned `amount` | Plaid signs `amount` instead: positive when money moves out (decided in ADR 0003)         |
| `bookedOn`                            | Plaid's `date` of a posted transaction; `authorized_date` has no counterpart in the texts |
| `counterparty`                        | Plaid's `counterparties`, which also carry a type and a confidence                        |

ISO 20022 camt.054 and OFX 2.x are the standards for a bank's debit and credit notices. Their pages could not be read on 2026-11-17 (iso20022.org answered 403, ofx.net an empty page), so this table does not use them.

## Why not a package from npm

Searched on 2026-11-02 and again on 2026-11-17: `keywords:stdlib sms`, `arab bank sms`, `bank sms parser`, `jordan bank`, `arabic bank sms`, `sms transaction parser`, `bank sms arabic`.

| Package                            | Why it does not do the job                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `sms-transaction-parser` 0.2.2     | Reads only Kenyan M-PESA and M-Shwari texts. Last release 2023-02-13, 5 downloads a week. |
| `@accounter/modern-poalim-scraper` | Scrapes the web sites of Israeli banks. It reads no text.                                 |
| `cbj-exchange-rate`                | The Central Bank of Jordan's exchange rates. It reads no text.                            |

Node has no export for the concept, and `Intl` formats numbers but does not parse them.

## Who uses what

| Consumer                                          | Uses                                          |
| ------------------------------------------------- | --------------------------------------------- |
| elt `apps/proactive` EarlyMonthSpend, SpendSpike  | `purchase` movements in `JOD`: `amount`       |
| elt `apps/proactive` MissingMidMonthCredit        | `transfer_in` movements of 1000 `JOD` or more |
| context-compiler `apps/ipay` BankCharges          | every debit movement                          |
| context-compiler `apps/ipay` bank-messages stream | `ArabBankText.senders`                        |

## The map

| Now (first release)                                                    | Later                                                              | Never                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| The movement templates of ipay's parser, and the two forms it misses   | The balance after a movement (`الرصيد`, `Balance`)                 | Which rows of a store to read                    |
| The notice templates of the 605 texts that no copy reads as a movement | The account that a text names (`500*0145`), to tell accounts apart | Months, weeks, limits and the user's clock       |
| `Unrecognized` for every other text                                    |                                                                    | Currency conversion                              |
| `ArabBankText.senders`                                                 |                                                                    | Other banks: each bank's texts get their own SDK |

## Decisions

- [ADR 0001: One SDK reads Arab Bank's texts for every reader](./docs/adr/0001-one-sdk-reads-arab-banks-texts-for-every-reader.md)
- [ADR 0002: Every text gets a reading, so a new template is never silent](./docs/adr/0002-every-text-gets-a-reading-so-a-new-template-is-never-silent.md)
- [ADR 0003: A movement's kind decides its direction](./docs/adr/0003-a-movements-kind-decides-its-direction.md)
- [ADR 0004: The amount is the decimal the bank wrote, and the day is the bank's](./docs/adr/0004-the-amount-is-the-decimal-the-bank-wrote-and-the-day-is-the-banks.md)
