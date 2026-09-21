import { AppleRemindersStream } from './apple-reminders-stream.ts';

export type Reminder = {
  id: string;
  name: string;
  // A reminder can belong to a list or a parent reminder.
  containerId: string;
  body: string | null;
  createdAt: string;
  modifiedAt: string;
  completed: boolean;
  completedAt: string | null;
  dueAt: string | null;
  // Native calendar date (YYYY-MM-DD), also present for timed reminders.
  allDayDueDate: string | null;
  remindAt: string | null;
  priority: number;
  flagged: boolean;
};

export class RemindersStream extends AppleRemindersStream<Reminder> {
  readonly name = 'reminders';
  readonly jsonSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      containerId: { type: 'string' },
      body: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      modifiedAt: { type: 'string', format: 'date-time' },
      completed: { type: 'boolean' },
      completedAt: { type: ['string', 'null'], format: 'date-time' },
      dueAt: { type: ['string', 'null'], format: 'date-time' },
      allDayDueDate: { type: ['string', 'null'], format: 'date' },
      remindAt: { type: ['string', 'null'], format: 'date-time' },
      priority: { type: 'integer', minimum: 0, maximum: 9 },
      flagged: { type: 'boolean' },
    },
    required: [
      'id',
      'name',
      'containerId',
      'body',
      'createdAt',
      'modifiedAt',
      'completed',
      'completedAt',
      'dueAt',
      'allDayDueDate',
      'remindAt',
      'priority',
      'flagged',
    ],
  } as const;

  protected readonly script = `
    (() => {
      const timestamp = date => date === null ? null : date.toISOString();
      const calendarDate = date => date === null ? null : [
        String(date.getFullYear()).padStart(4, '0'),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
      ].join('-');
      return app.reminders().map(reminder => {
        const properties = reminder.properties();
        return {
          id: properties.id,
          name: properties.name,
          containerId: properties.container.id(),
          body: properties.body,
          createdAt: properties.creationDate.toISOString(),
          modifiedAt: properties.modificationDate.toISOString(),
          completed: properties.completed,
          completedAt: timestamp(properties.completionDate),
          dueAt: timestamp(properties.dueDate),
          allDayDueDate: calendarDate(properties.alldayDueDate),
          remindAt: timestamp(properties.remindMeDate),
          priority: properties.priority,
          flagged: properties.flagged
        };
      });
    })()
  `;

  protected validate(reminders: unknown): Reminder[] {
    if (
      !Array.isArray(reminders) ||
      !reminders.every(
        (reminder) =>
          reminder !== null &&
          typeof reminder === 'object' &&
          !Array.isArray(reminder) &&
          typeof reminder.id === 'string' &&
          typeof reminder.name === 'string' &&
          typeof reminder.containerId === 'string' &&
          (reminder.body === null || typeof reminder.body === 'string') &&
          this.isTimestamp(reminder.createdAt) &&
          this.isTimestamp(reminder.modifiedAt) &&
          typeof reminder.completed === 'boolean' &&
          [reminder.completedAt, reminder.dueAt, reminder.remindAt].every(
            (date) => date === null || this.isTimestamp(date),
          ) &&
          (reminder.allDayDueDate === null ||
            (typeof reminder.allDayDueDate === 'string' &&
              /^\d{4}-\d{2}-\d{2}$/.test(reminder.allDayDueDate) &&
              this.isTimestamp(`${reminder.allDayDueDate}T00:00:00.000Z`))) &&
          Number.isInteger(reminder.priority) &&
          reminder.priority >= 0 &&
          reminder.priority <= 9 &&
          typeof reminder.flagged === 'boolean',
      )
    )
      throw new TypeError('Reminders returned an unexpected reminder format');
    return reminders;
  }

  private isTimestamp(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value
    );
  }
}
