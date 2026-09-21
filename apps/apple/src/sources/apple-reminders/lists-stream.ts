import { AppleRemindersStream } from './apple-reminders-stream.ts';

export type List = {
  id: string;
  name: string;
  // A list can belong to an account or another list.
  containerId: string;
  color: string;
  emblem: string | null;
};

export class ListsStream extends AppleRemindersStream<List> {
  readonly name = 'lists';
  readonly jsonSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      containerId: { type: 'string' },
      color: { type: 'string' },
      emblem: { type: ['string', 'null'] },
    },
    required: ['id', 'name', 'containerId', 'color', 'emblem'],
  } as const;

  protected readonly script = `
    app.lists().map(list => {
      const properties = list.properties();
      return {
        id: properties.id,
        name: properties.name,
        containerId: properties.container.id(),
        color: properties.color,
        emblem: properties.emblem
      };
    })
  `;

  protected validate(lists: unknown): List[] {
    if (
      !Array.isArray(lists) ||
      !lists.every(
        (list) =>
          list !== null &&
          typeof list === 'object' &&
          !Array.isArray(list) &&
          typeof list.id === 'string' &&
          typeof list.name === 'string' &&
          typeof list.containerId === 'string' &&
          typeof list.color === 'string' &&
          (list.emblem === null || typeof list.emblem === 'string'),
      )
    )
      throw new TypeError('Reminders returned an unexpected list format');
    return lists;
  }
}
