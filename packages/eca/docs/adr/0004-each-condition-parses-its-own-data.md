# Each condition parses its own data

The spend of the user is in bank SMS in the Messages import, as Arabic text: `تم قيد حركة شراء من حسابكم … بمبلغ JOD 8.920 بتاريخ …`. A condition must read the amount, the kind of the message, and the date from this text. It must also skip the traps: a one-time-password SMS also contains `حركة شراء بمبلغ 30 JOD`, for a purchase that did not happen yet.

A view such as `bank_transactions` could parse the SMS one time for all the conditions that need money. The Messages connector cannot ship that view, because it does not know the banks of each user. The user decided that each condition parses its own data.

## Considered Options

- **The connector ships the views of known banks.** It works only for the banks that the connector knows.
- **The agent writes a shared view, and eca keeps it for the next conditions.** One parse for all the conditions. eca then also stores and versions views.
- **Each condition parses its data in its own code.** This option was selected.

## Consequences

- A condition is code with SQL in it. It reads the rows with SQL and parses them in TypeScript.
- Two conditions about money each contain the parse of the SMS.
- eca keeps no views. It keeps only the matches of each rule, in memory.
