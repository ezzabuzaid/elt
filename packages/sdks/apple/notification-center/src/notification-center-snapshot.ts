import {
  type PlistValue,
  decodeArchive,
  isBinaryPlist,
  isDictionary,
  parseBinaryPlist,
} from '@workspace/codec-plist';
import {
  AppDatabase,
  type AppDatabaseColumns,
} from '@workspace/sdk-apple-app-database';

import {
  NotificationCenterSchemaError,
  NotificationCenterUnavailableError,
} from './errors.ts';
import {
  type CategoryAction,
  type Notification,
  type NotificationApp,
  type NotificationCategory,
  interruptionLevels,
} from './notification.ts';

const requiredColumns = {
  app: ['app_id', 'identifier', 'badge'],
  record: ['rec_id', 'app_id', 'uuid', 'data', 'delivered_date', 'style'],
  categories: ['app_id', 'categories'],
} satisfies AppDatabaseColumns;

// The store as of one moment: everything read through it agrees. A layout
// missing any column this reader reads is refused when the snapshot opens.
// Hold it only while reading: an open read stops usernoted checkpointing its
// WAL.
export class NotificationCenterSnapshot implements Disposable {
  readonly #database: AppDatabase;

  constructor(path: string) {
    this.#database = new AppDatabase(path, NotificationCenterUnavailableError);
    this.#database.requireColumns(
      requiredColumns,
      NotificationCenterSchemaError,
    );
  }

  notifications(): Notification[] {
    return this.#database
      .all(
        'SELECT uuid, data, delivered_date AS deliveredAt, style FROM record ORDER BY rec_id',
      )
      .map((row) => {
        const payload = expand(parseBinaryPlist(bytes(row.data)));
        if (!isDictionary(payload) || !isDictionary(payload.req))
          throw new TypeError('A notification record holds no request');
        const request = payload.req;
        const level = request.intrp;
        return {
          id: uuid(row.uuid),
          bundleId: required(payload.app, 'A notification names no app'),
          deliveredAt: instant(Number(row.deliveredAt)),
          requestId: text(request.iden),
          threadId: text(request.thre),
          category: text(request.cate),
          title: text(request.titl),
          subtitle: text(request.subt),
          body: text(request.body),
          defaultActionUrl: text(request.durl),
          soundName: isDictionary(request.soun) ? text(request.soun.nam) : null,
          expiresAt:
            typeof request.edat === 'number' ? instant(request.edat) : null,
          interruptionLevel:
            typeof level === 'number'
              ? (interruptionLevels[level] ?? null)
              : null,
          contentType: text(request.unct),
          style: row.style === null ? null : Number(row.style),
          userInfo: request.usda ?? null,
          payload,
        };
      });
  }

  apps(): NotificationApp[] {
    return this.#database
      .all('SELECT identifier, badge FROM app ORDER BY app_id')
      .map((row) => ({
        bundleId: required(row.identifier, 'An app has no identifier'),
        badge: row.badge === null ? null : Number(row.badge),
      }));
  }

  categories(): NotificationCategory[] {
    return this.#database
      .all(
        `SELECT app.identifier AS bundleId, categories.categories AS list
         FROM categories JOIN app USING (app_id)
         ORDER BY app.app_id`,
      )
      .flatMap((row) => {
        const bundleId = required(row.bundleId, 'An app has no identifier');
        const list = parseBinaryPlist(bytes(row.list));
        if (!Array.isArray(list))
          throw new TypeError(`${bundleId}'s categories are not a list`);
        return list.map((entry, position) => {
          if (!isDictionary(entry))
            throw new TypeError(
              `${bundleId}'s category ${position} is no dictionary`,
            );
          return {
            bundleId,
            position,
            id: required(
              entry.id,
              `${bundleId}'s category ${position} has no identifier`,
            ),
            options: integer(entry.opt),
            intentIdentifiers: Array.isArray(entry.ints)
              ? entry.ints.map((intent) =>
                  required(
                    intent,
                    `${bundleId}'s category ${position} names an intent that is no text`,
                  ),
                )
              : null,
            hiddenPreviewsBodyPlaceholder: localized(entry.hidb),
            summaryFormat: localized(entry.sumf),
            actionsMenuTitle: localized(entry.atit),
            actions: (Array.isArray(entry.acts) ? entry.acts : []).map(
              (action, index): CategoryAction => {
                if (!isDictionary(action))
                  throw new TypeError(
                    `${bundleId}'s action ${index} is no dictionary`,
                  );
                return {
                  position: index,
                  id: required(
                    action.id,
                    `${bundleId}'s action ${index} has no identifier`,
                  ),
                  title: localized(action.ti),
                  options: integer(action.op),
                  typeCode: integer(action.st),
                  textInputButtonTitle: localized(action.tia),
                  textInputPlaceholder: localized(action.tip),
                };
              },
            ),
          };
        });
      });
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}

// usernoted nests archives, such as a request's userInfo, as data inside the
// record; each is decoded where it sits.
function expand(value: PlistValue): PlistValue {
  if (value instanceof Uint8Array)
    return isBinaryPlist(value) ? expand(decodeArchive(value)) : value;
  if (Array.isArray(value)) return value.map(expand);
  if (!isDictionary(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, expand(field)]),
  );
}

// A localized text is [key, key, arguments]; usernoted keeps the key.
function localized(value: PlistValue | undefined): string | null {
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

function bytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array))
    throw new TypeError('A Notification Center blob is not bytes');
  return value;
}

function uuid(value: unknown): string {
  const hex = Buffer.from(bytes(value)).toString('hex');
  if (hex.length !== 32)
    throw new TypeError('A notification UUID is not 16 bytes');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase();
}

function required(value: unknown, missing: string): string {
  if (typeof value !== 'string') throw new TypeError(missing);
  return value;
}

function text(value: PlistValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function integer(value: PlistValue | undefined): number | null {
  return typeof value === 'number' ? value : null;
}

// usernoted's dates are seconds since 2001-01-01 in a double, which resolves
// about a tenth of a microsecond today, so they are written to the microsecond.
function instant(value: number): string {
  const micros = Math.round(value * 1e6);
  const seconds = Math.floor(micros / 1e6);
  const whole = new Date((seconds + 978307200) * 1000).toISOString();
  return `${whole.slice(0, 19)}.${String(micros - seconds * 1e6).padStart(6, '0')}Z`;
}
