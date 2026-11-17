# The amount is the decimal the bank wrote, and the day is the bank's

The readers use an amount in different ways. The proactive rules sum fils as integers (`Number('8' + '920')`), and ipay keeps the amount as text for a Postgres `numeric`. A JavaScript `number` loses exactness in sums, and the minor unit differs by currency: a fils is 1/1000 of a JOD, a cent 1/100 of a USD.

Thus `amount` is the decimal string that the bank wrote, without thousands separators, and `currency` is the code that the text states. The reader converts it to the unit of its job.

The day of a movement is the bank's. The bank states a day in most texts (`بتاريخ 04/03/2026`), and that day can be the next business day after the purchase. `bookedOn` is that day as a `Temporal.PlainDate`, else the day that the text was sent on the bank's clock, Asia/Amman. The input `sentAt` is a `Temporal.Instant`, so a text's time has one meaning.

## Considered Options

- **A `number` amount.** Sums lose exactness.
- **A `bigint` of minor units.** The SDK must then know the minor unit of each currency, which ISO 4217 already gives to the reader that needs it.
- **Strings for `bookedOn` and `sentAt`, as ipay has them.** A string can hold a time in any zone, or no date.
- **A decimal string and Temporal values.** This option was selected.

## Consequences

- ipay serializes `bookedOn` with `toString()` where it stores text.
- A reader that judges a window on the user's clock, such as "days 1 to 10 of a month", reads the sent time, not `bookedOn`. The proactive rules keep doing that.
