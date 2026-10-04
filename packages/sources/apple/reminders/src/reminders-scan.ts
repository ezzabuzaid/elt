import type {
  AccountDocument,
  CalendarDocument,
  RecurrenceRuleDocument,
  ReminderDocument,
  RemindersContents,
} from '@workspace/macos-eventkit';

// The helper's epoch milliseconds as a UTC timestamp.
export const timestamp = (ms: number | undefined): string | null =>
  ms === undefined ? null : new Date(ms).toISOString();

export type RuleEntry = {
  readonly reminderId: string;
  readonly ruleId: string;
  readonly position: number;
  readonly rule: RecurrenceRuleDocument;
};

// One run's change-free EventKit read: every selected stream projects its
// rows from it, so reminders match their lists and alarms their reminders.
// The read is complete when the scan exists, so it holds nothing to release.
export class RemindersScan implements AsyncDisposable {
  readonly accounts: readonly AccountDocument[];
  // Reminder lists, which EventKit calls calendars.
  readonly lists: readonly CalendarDocument[];
  readonly reminders: readonly ReminderDocument[];
  #rules?: RuleEntry[];

  constructor({ accounts, calendars, reminders }: RemindersContents) {
    this.accounts = accounts;
    this.lists = calendars;
    this.reminders = reminders;
  }

  // Each recurrence rule with the id its values refer to, built once for
  // both rule streams.
  get rules(): readonly RuleEntry[] {
    this.#rules ??= this.reminders.flatMap((reminder) =>
      reminder.recurrenceRules.map((rule, position) => ({
        reminderId: reminder.id,
        ruleId: JSON.stringify([reminder.id, 'recurrenceRule', position]),
        position,
        rule,
      })),
    );
    return this.#rules;
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}
