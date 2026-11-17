# Arab Bank SMS

Arab Bank sends its customers a text for each movement of their accounts, and texts that tell of no movement. A caller gives `ArabBankText.read` one text and the instant that it was sent, and gets one reading: a movement, a notice, or unrecognized.

## Language

**Text**:
One SMS from the bank, as Messages stores it.
_Avoid_: Message (a Messages row also holds iMessages), SMS alert, notification

**Sender**:
A name that Messages gives the bank's texts: `Arab Bank`, and `ArabBank` until March 2024.
_Avoid_: Handle (a handle is a Messages row), bank

**Template**:
One form of text that the bank sends, such as its Arabic card purchase or its English CliQ debit.
_Avoid_: Pattern (a pattern is the regular expression that matches a template), format

**Reading**:
What a text tells, as the SDK reads it: one movement, one notice, or unrecognized.
_Avoid_: Parse result, match

**Movement**:
One change of an account's balance that a text tells of. The bank's own word for it is حركة.
_Avoid_: Transaction (a database word in this repo), entry, charge (ipay's charge is a debit movement)

**Kind**:
What a movement is: `purchase`, `withdrawal`, `cliq_out`, `cliq_in`, `bill`, `card_payment`, `card_credit`, `transfer_out`, `transfer_in`, `salary`, `deposit` or `reversal`. The kind decides the direction.
_Avoid_: Type (the reading's `type` says movement, notice or unrecognized), category

**Direction**:
Whether a movement takes money from the account (`debit`) or gives money to it (`credit`).
_Avoid_: Sign, side

**Counterparty**:
Who the money went to or came from, as the text names them.
_Avoid_: Merchant (one kind of counterparty), payee

**Booked day**:
The day that the bank books a movement on, on the bank's clock: the day that the text states, else the day that it was sent.
_Avoid_: Date (the text's sent time is also a date), posted date

**Notice**:
A text of a known template that tells of no movement: a one-time password, a refused attempt, a statement, a sign-in alert, a points balance or an offer.
_Avoid_: Ignored text, noise, spam

**Unrecognized**:
The reading of a text that matches no template that the SDK knows. It is the sign of a new template.
_Avoid_: Unknown, failed, null
