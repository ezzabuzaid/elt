# Every text gets a reading, so a new template is never silent

ipay's `movement(text, sentAt)` gives a movement or `null`. `null` means two different things: a text of a known template that tells of no movement, such as a one-time password, and a text that no template matches. A reader cannot tell them apart, so a new template is read as nothing.

This happened twice. The bank wrote `JOD165` without a space from 2020-08 to 2025-02, and the proactive copies read 1,315 of those purchases as nothing. Since at least 2026-11-13 the bank sends an English CliQ debit, `JOD… has been debited from … to … as CliQ transfer`, and ipay reads each one as nothing (context-compiler #4543).

Thus `ArabBankText.read` gives one of three readings:

```ts
type Reading = Movement | Notice | Unrecognized;

class Movement {
  readonly type = 'movement';
  readonly kind: MovementKind;
  readonly counterparty?: string;
  readonly amount: string;
  readonly currency: string;
  readonly bookedOn: Temporal.PlainDate;
  get direction(): 'debit' | 'credit';
}

class Notice {
  readonly type = 'notice';
  readonly kind:
    | 'one_time_password'
    | 'refused'
    | 'statement'
    | 'sign_in'
    | 'points'
    | 'offer'
    | 'service';
}

class Unrecognized {
  readonly type = 'unrecognized';
}
```

The notice kinds come from the 605 texts that ipay reads as no movement. The build measures them again against every text and changes the list only where a group of real texts needs it.

## Considered Options

- **`Movement | null`, as ipay has it.** A new template is silent.
- **Throw for an unrecognized text.** One new template would stop every reader at its first text. The reader, not the SDK, decides what an unrecognized text means for its job.
- **`Movement | null`, plus a count of unmatched texts that the caller asks for.** A count says how many but not which; the caller needs the text to report it.
- **Three readings.** This option was selected.

## Consequences

- The SDK knows the notice templates as well as the movement templates. Its tests cover every template with a masked real text.
- A reader can tell the user about an unrecognized text. For example, a proactive rule matches each unrecognized Arab Bank text, so the next new template reaches the user on the day it arrives.
- The movement and notice templates must not overlap: no text matches two of them. A test checks each template against the texts of every other template.
