import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  eventKitFields
} from "../../chunks/chunk-YUEL2AIL.mjs";
import {
  decodeArchive,
  isBinaryPlist,
  isDictionary,
  parseBinaryPlist,
  plistJSON
} from "../../chunks/chunk-GXPN73JS.mjs";
import {
  withinDates
} from "../../chunks/chunk-YM7ADF2O.mjs";
import {
  localAppleStoreCoverage
} from "../../chunks/chunk-BRJ4TKR5.mjs";
import {
  AppDatabase,
  AppDatabaseVersion
} from "../../chunks/chunk-SDFTRGL6.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-PGV23ONC.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffSnapshot,
  validateRecords
} from "../../chunks/chunk-OC6XOTPF.mjs";
import {
  __callDispose,
  __using
} from "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/sources/apple/notification-center/dist/apple-notification-center-source.js
import { setInterval } from "node:timers/promises";

// packages/sdks/apple/notification-center/dist/errors.js
var NotificationCenterUnavailableError = class extends Error {
  name = "NotificationCenterUnavailableError";
  constructor(path, cause) {
    super(`The Notification Center store at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security.`, { cause });
  }
};
var NotificationCenterSchemaError = class extends Error {
  name = "NotificationCenterSchemaError";
  constructor(path, missing) {
    super(`The Notification Center store at ${path} has a layout this reader does not read (missing ${missing.join(", ")}).`);
  }
};

// packages/sdks/apple/notification-center/dist/notification.js
var interruptionLevels = [
  "passive",
  "active",
  "timeSensitive",
  "critical"
];

// packages/sdks/apple/notification-center/dist/notification-center-snapshot.js
var requiredColumns = {
  app: ["app_id", "identifier", "badge"],
  record: ["rec_id", "app_id", "uuid", "data", "delivered_date", "style"],
  categories: ["app_id", "categories"]
};
var NotificationCenterSnapshot = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, NotificationCenterUnavailableError);
    this.#database.requireColumns(requiredColumns, NotificationCenterSchemaError);
  }
  notifications() {
    return this.#database.all("SELECT uuid, data, delivered_date AS deliveredAt, style FROM record ORDER BY rec_id").map((row) => {
      const payload = expand(parseBinaryPlist(bytes(row.data)));
      if (!isDictionary(payload) || !isDictionary(payload.req))
        throw new TypeError("A notification record holds no request");
      const request = payload.req;
      const level = request.intrp;
      return {
        id: uuid(row.uuid),
        bundleId: required(payload.app, "A notification names no app"),
        deliveredAt: instant(Number(row.deliveredAt)),
        requestId: text(request.iden),
        threadId: text(request.thre),
        category: text(request.cate),
        title: text(request.titl),
        subtitle: text(request.subt),
        body: text(request.body),
        defaultActionUrl: text(request.durl),
        soundName: isDictionary(request.soun) ? text(request.soun.nam) : null,
        expiresAt: typeof request.edat === "number" ? instant(request.edat) : null,
        interruptionLevel: typeof level === "number" ? interruptionLevels[level] ?? null : null,
        contentType: text(request.unct),
        style: row.style === null ? null : Number(row.style),
        userInfo: request.usda ?? null,
        payload
      };
    });
  }
  apps() {
    return this.#database.all("SELECT identifier, badge FROM app ORDER BY app_id").map((row) => ({
      bundleId: required(row.identifier, "An app has no identifier"),
      badge: row.badge === null ? null : Number(row.badge)
    }));
  }
  categories() {
    return this.#database.all(`SELECT app.identifier AS bundleId, categories.categories AS list
         FROM categories JOIN app USING (app_id)
         ORDER BY app.app_id`).flatMap((row) => {
      const bundleId = required(row.bundleId, "An app has no identifier");
      const list = parseBinaryPlist(bytes(row.list));
      if (!Array.isArray(list))
        throw new TypeError(`${bundleId}'s categories are not a list`);
      return list.map((entry, position) => {
        if (!isDictionary(entry))
          throw new TypeError(`${bundleId}'s category ${position} is no dictionary`);
        return {
          bundleId,
          position,
          id: required(entry.id, `${bundleId}'s category ${position} has no identifier`),
          options: integer(entry.opt),
          intentIdentifiers: Array.isArray(entry.ints) ? entry.ints.map((intent) => required(intent, `${bundleId}'s category ${position} names an intent that is no text`)) : null,
          hiddenPreviewsBodyPlaceholder: localized(entry.hidb),
          summaryFormat: localized(entry.sumf),
          actionsMenuTitle: localized(entry.atit),
          actions: (Array.isArray(entry.acts) ? entry.acts : []).map((action, index) => {
            if (!isDictionary(action))
              throw new TypeError(`${bundleId}'s action ${index} is no dictionary`);
            return {
              position: index,
              id: required(action.id, `${bundleId}'s action ${index} has no identifier`),
              title: localized(action.ti),
              options: integer(action.op),
              typeCode: integer(action.st),
              textInputButtonTitle: localized(action.tia),
              textInputPlaceholder: localized(action.tip)
            };
          })
        };
      });
    });
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
};
function expand(value) {
  if (value instanceof Uint8Array)
    return isBinaryPlist(value) ? expand(decodeArchive(value)) : value;
  if (Array.isArray(value))
    return value.map(expand);
  if (!isDictionary(value))
    return value;
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, expand(field)]));
}
function localized(value) {
  if (typeof value === "string")
    return value;
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}
function bytes(value) {
  if (!(value instanceof Uint8Array))
    throw new TypeError("A Notification Center blob is not bytes");
  return value;
}
function uuid(value) {
  const hex = Buffer.from(bytes(value)).toString("hex");
  if (hex.length !== 32)
    throw new TypeError("A notification UUID is not 16 bytes");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase();
}
function required(value, missing) {
  if (typeof value !== "string")
    throw new TypeError(missing);
  return value;
}
function text(value) {
  return typeof value === "string" ? value : null;
}
function integer(value) {
  return typeof value === "number" ? value : null;
}
function instant(value) {
  const micros = Math.round(value * 1e6);
  const seconds = Math.floor(micros / 1e6);
  const whole = new Date((seconds + 978307200) * 1e3).toISOString();
  return `${whole.slice(0, 19)}.${String(micros - seconds * 1e6).padStart(6, "0")}Z`;
}

// packages/sdks/apple/notification-center/dist/notification-center-store.js
import { homedir } from "node:os";
import { join } from "node:path";
var notificationCenterStorePath = join(homedir(), "Library/Group Containers/group.com.apple.usernoted/db2/db");
var NotificationCenterStore = class {
  #path;
  constructor(path) {
    this.#path = path;
  }
  // The store as of one moment, so a notification and its app agree.
  open() {
    return new NotificationCenterSnapshot(this.#path);
  }
  // A probe whose current value changes with each commit to the store, such
  // as usernoted delivering, withdrawing or badging.
  version() {
    return new AppDatabaseVersion(this.#path, NotificationCenterUnavailableError);
  }
};

// packages/sources/apple/notification-center/dist/notification-center-scan.js
var toMilliseconds = (instant3) => `${instant3.slice(0, 23)}Z`;
var NotificationCenterScan = class {
  #snapshot;
  #scope;
  #notifications;
  #apps;
  #categories;
  constructor(snapshot, scope) {
    this.#snapshot = snapshot;
    this.#scope = scope;
  }
  get notifications() {
    this.#notifications ??= this.#snapshot.notifications().filter(({ deliveredAt }) => withinDates(this.#scope, toMilliseconds(deliveredAt)));
    return this.#notifications;
  }
  get apps() {
    this.#apps ??= this.#snapshot.apps();
    return this.#apps;
  }
  get categories() {
    this.#categories ??= this.#snapshot.categories();
    return this.#categories;
  }
  async [Symbol.asyncDispose]() {
    this.#snapshot[Symbol.dispose]();
  }
};

// packages/sources/apple/notification-center/dist/apple-notification-center-stream.js
var notificationCenterFields = {
  ...eventKitFields,
  nullableInteger: { type: ["integer", "null"] },
  nullableTextList: { type: ["array", "null"], items: { type: "string" } },
  instant: { type: "string", format: "date-time", precision: 6 },
  nullableInstant: {
    type: ["string", "null"],
    format: "date-time",
    precision: 6
  }
};
var AppleNotificationCenterStream = class {
  supportedSyncModes = Object.freeze([
    "full_refresh",
    "incremental"
  ]);
  // Every read is the whole store, so incremental copies diff snapshots.
  sourceDefinedCursor = true;
  #stream;
  describe() {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }
  read(scan) {
    return validateRecords(this, this.rows(scan).flatMap((row) => this.records(row)), "Notification Center");
  }
};

// packages/sources/apple/notification-center/dist/streams/apps-stream.js
var { id, nullableInteger } = notificationCenterFields;
var properties = {
  bundleId: {
    ...id,
    description: "The app\u2019s bundle identifier, lowercased as usernoted keys it (app.identifier); system senders carry a _system_center_: prefix."
  },
  badge: {
    ...nullableInteger,
    description: "The number on the app\u2019s icon (app.badge); NULL when it shows none."
  }
};
var AppsStream = class extends AppleNotificationCenterStream {
  name = "apps";
  primaryKey = ["bundleId"];
  emitsDeletes = true;
  jsonSchema = {
    type: "object",
    description: "One record per app that has posted to Notification Center, with its badge now. Primary key bundleId. An app macOS forgets, such as one uninstalled, is deleted.",
    properties,
    required: Object.keys(properties)
  };
  rows(scan) {
    return scan.apps;
  }
  records(app) {
    return [{ bundleId: app.bundleId, badge: app.badge }];
  }
};

// packages/sources/apple/notification-center/dist/streams/categories-stream.js
var { id: id2, ordinal, nullableInteger: nullableInteger2, nullableText, nullableTextList } = notificationCenterFields;
var properties2 = {
  bundleId: {
    ...id2,
    description: "The app that registered it; refers to apps.bundleId."
  },
  position: {
    ...ordinal,
    description: "Its place in the list the app registered, from 0; an app can register one identifier twice, so the position, not the identifier, tells them apart."
  },
  id: {
    ...id2,
    description: "The category identifier (id) that notifications.category names."
  },
  options: {
    ...nullableInteger2,
    description: "Its UNNotificationCategoryOptions bits (opt)."
  },
  intentIdentifiers: {
    ...nullableTextList,
    description: "The SiriKit intents its notifications relate to (ints); NULL when it names none."
  },
  hiddenPreviewsBodyPlaceholder: {
    ...nullableText,
    description: "The text shown instead of the body when previews are hidden (hidb), or its localization key; NULL when the app set none."
  },
  summaryFormat: {
    ...nullableText,
    description: "The format of the summary of a group of its notifications (sumf), or its localization key; NULL when the app set none."
  },
  actionsMenuTitle: {
    ...nullableText,
    description: "The title of its actions menu (atit), or its localization key; NULL when the app set none."
  }
};
var CategoriesStream = class extends AppleNotificationCenterStream {
  name = "categories";
  primaryKey = ["bundleId", "position"];
  emitsDeletes = true;
  jsonSchema = {
    type: "object",
    description: "One record per notification category an app registered, the kinds of notification it posts and the buttons they carry (categoryActions). Primary key bundleId, position. A category the app stops registering is deleted.",
    properties: properties2,
    required: Object.keys(properties2)
  };
  rows(scan) {
    return scan.categories;
  }
  records(category) {
    return [
      {
        bundleId: category.bundleId,
        position: category.position,
        id: category.id,
        options: category.options,
        intentIdentifiers: category.intentIdentifiers,
        hiddenPreviewsBodyPlaceholder: category.hiddenPreviewsBodyPlaceholder,
        summaryFormat: category.summaryFormat,
        actionsMenuTitle: category.actionsMenuTitle
      }
    ];
  }
};

// packages/sources/apple/notification-center/dist/streams/category-actions-stream.js
var { id: id3, ordinal: ordinal2, nullableInteger: nullableInteger3, nullableText: nullableText2 } = notificationCenterFields;
var properties3 = {
  bundleId: {
    ...id3,
    description: "The app that registered it; refers to apps.bundleId."
  },
  categoryPosition: {
    ...ordinal2,
    description: "Its category; refers to categories.position for the same app."
  },
  position: {
    ...ordinal2,
    description: "Its place among the category\u2019s buttons, from 0."
  },
  id: { ...id3, description: "The action identifier (id)." },
  title: {
    ...nullableText2,
    description: "The button\u2019s title (ti), or its localization key when the app registered it localized."
  },
  options: {
    ...nullableInteger3,
    description: "Its UNNotificationActionOptions bits (op)."
  },
  typeCode: {
    ...nullableInteger3,
    description: "usernoted\u2019s code for the kind of action (st): 1 on a text-input action, NULL on a plain one; Apple does not document the codes."
  },
  textInputButtonTitle: {
    ...nullableText2,
    description: "A text-input action\u2019s send button title (tia), or its localization key; NULL on a plain action."
  },
  textInputPlaceholder: {
    ...nullableText2,
    description: "A text-input action\u2019s placeholder (tip), or its localization key; NULL on a plain action."
  }
};
var CategoryActionsStream = class extends AppleNotificationCenterStream {
  name = "categoryActions";
  primaryKey = ["bundleId", "categoryPosition", "position"];
  emitsDeletes = true;
  jsonSchema = {
    type: "object",
    description: "One record per button a notification category puts on its notifications, such as Reply or Mark as Read. Primary key bundleId, categoryPosition, position.",
    properties: properties3,
    required: Object.keys(properties3)
  };
  rows(scan) {
    return scan.categories.flatMap((category) => category.actions.map((action) => ({
      ...action,
      bundleId: category.bundleId,
      categoryPosition: category.position
    })));
  }
  records(action) {
    return [
      {
        bundleId: action.bundleId,
        categoryPosition: action.categoryPosition,
        position: action.position,
        id: action.id,
        title: action.title,
        options: action.options,
        typeCode: action.typeCode,
        textInputButtonTitle: action.textInputButtonTitle,
        textInputPlaceholder: action.textInputPlaceholder
      }
    ];
  }
};

// packages/sources/apple/notification-center/dist/streams/notifications-stream.js
var { id: id4, text: text2, nullableInteger: nullableInteger4, nullableText: nullableText3, instant: instant2, nullableInstant } = notificationCenterFields;
var properties4 = {
  id: {
    ...id4,
    description: "The delivery\u2019s UUID (record.uuid), uppercase as NSUUID writes it; Activity\u2019s notificationUsage.notificationId names a notification by it."
  },
  bundleId: {
    ...text2,
    description: "Bundle identifier of the app that posted it, in the app\u2019s own case; apps.bundleId is the same identifier lowercased."
  },
  deliveredAt: {
    ...instant2,
    description: "When Notification Center delivered it, to the microsecond."
  },
  requestId: {
    ...nullableText3,
    description: "The identifier the app gave the request (req.iden); Activity\u2019s notificationDeliveries.requestId. An app that posts again under it replaces this notification with a new one. NULL for notifications posted through the legacy API."
  },
  threadId: {
    ...nullableText3,
    description: "The thread the app groups it under (req.thre), such as a chat or a conversation; NULL when it set none."
  },
  category: {
    ...nullableText3,
    description: "The category the app gave it (req.cate); refers to categories.id for the same app. NULL when it set none."
  },
  title: { ...nullableText3, description: "Its title (req.titl)." },
  subtitle: { ...nullableText3, description: "Its subtitle (req.subt)." },
  body: { ...nullableText3, description: "Its text (req.body)." },
  defaultActionUrl: {
    ...nullableText3,
    description: "The URL clicking it opens (req.durl), such as a messages:// link to the message; NULL when the app handles the click itself."
  },
  soundName: {
    ...nullableText3,
    description: "The sound it played (req.soun); NULL when it played the default sound or none."
  },
  expiresAt: {
    ...nullableInstant,
    description: "When usernoted removes it (req.edat), such as when a calendar event ends; NULL when it does not expire."
  },
  interruptionLevel: {
    type: ["string", "null"],
    enum: ["passive", "active", "timeSensitive", "critical"],
    description: "Its UNNotificationInterruptionLevel (req.intrp); NULL when the app left the default."
  },
  contentType: {
    ...nullableText3,
    description: "The kind of communication it declares (req.unct), such as UNNotificationContentTypeMessagingDirect; NULL for an ordinary notification."
  },
  style: {
    ...nullableInteger4,
    description: "usernoted\u2019s code for how it is shown (record.style), 0 or 1 on macOS 27; Apple does not document the codes. NULL when not stored."
  },
  userInfo: {
    ...nullableText3,
    description: "The app\u2019s own payload (req.usda) as JSON, naming the record it is about in the app\u2019s store: a Messages message GUID, a Mail message ID, a Calendar event, a Codex conversation_id. NULL when the app sent none."
  },
  payload: {
    ...text2,
    description: "Everything usernoted stores for the notification (record.data) as JSON, nested archives decoded, data as Base64: the fields above under their stored keys, and the ones this source does not name."
  }
};
var NotificationsStream = class extends AppleNotificationCenterStream {
  name = "notifications";
  primaryKey = ["id"];
  emitsDeletes = void 0;
  jsonSchema = {
    type: "object",
    description: "One record per notification Notification Center delivered while an import read its store. Primary key id. Notification Center keeps a notification for minutes to days; a notification it no longer holds stays loaded, so rows are a history, not what Notification Center shows now.",
    properties: properties4,
    required: Object.keys(properties4)
  };
  rows(scan) {
    return scan.notifications;
  }
  records(notification) {
    return [
      {
        id: notification.id,
        bundleId: notification.bundleId,
        deliveredAt: notification.deliveredAt,
        requestId: notification.requestId,
        threadId: notification.threadId,
        category: notification.category,
        title: notification.title,
        subtitle: notification.subtitle,
        body: notification.body,
        defaultActionUrl: notification.defaultActionUrl,
        soundName: notification.soundName,
        expiresAt: notification.expiresAt,
        interruptionLevel: notification.interruptionLevel,
        contentType: notification.contentType,
        style: notification.style,
        userInfo: notification.userInfo === null ? null : plistJSON(notification.userInfo),
        payload: plistJSON(notification.payload)
      }
    ];
  }
};

// packages/sources/apple/notification-center/dist/apple-notification-center-source.js
var readers = {
  notifications: new NotificationsStream(),
  apps: new AppsStream(),
  categories: new CategoriesStream(),
  categoryActions: new CategoryActionsStream()
};
var catalog = new Catalog(Object.values(readers).map((reader) => reader.describe()));
var readersByName = new Map(Object.values(readers).map((reader) => [reader.name, reader]));
var pollIntervalMs = 1e3;
var AppleNotificationCenterSource = class extends Source {
  identity;
  catalog = catalog;
  notifications = readers.notifications.describe();
  apps = readers.apps.describe();
  categories = readers.categories.describe();
  categoryActions = readers.categoryActions.describe();
  path;
  scope;
  #store;
  constructor(path = notificationCenterStorePath, scope = {}) {
    super();
    this.path = path;
    this.scope = scope;
    this.#store = new NotificationCenterStore(path);
    this.identity = `apple-notification-center:${path}`;
    Object.freeze(this);
  }
  async open() {
    return new NotificationCenterScan(this.#store.open(), this.scope);
  }
  coverage(_stream) {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }
  // One database whose data_version cannot say which table a commit touched,
  // so each commit wakes every selected stream; the snapshot diff writes
  // nothing for the ones that did not change.
  async *observe({ streams, signal }) {
    var _stack = [];
    try {
      if (signal.aborted)
        return;
      const version = __using(_stack, this.#store.version());
      let seen = version.current;
      yield streams;
      try {
        for await (const _2 of setInterval(pollIntervalMs, void 0, {
          signal
        })) {
          const current = version.current;
          if (current === seen)
            continue;
          seen = current;
          yield streams;
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError"))
          throw error;
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  async *extract(configuration, state, _partition, scan) {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === void 0)
      throw new Error(`Apple Notification Center has no stream ${stream.name}`);
    const records = reader.read(scan);
    yield* configuration.syncMode === "incremental" ? diffSnapshot(stream, records, state) : records.map((data) => ({ stream: stream.name, data }));
  }
};

// packages/connectors/apple/notification-center/dist/notification-center-connector.js
var NotificationCenterConnector = class extends AppleConnector {
  datedBy = "delivery date";
  fullDiskAccess = true;
  // One store of every app's notifications; a date range is the only
  // narrowing.
  choices = [];
  // Reading the notifications opens the protected Notification Center store.
  probe = "notifications";
  unscoped = [];
  storeCopies = [];
  access() {
    return "No app needs to be open: macOS keeps every app\u2019s notifications in one store while Notification Center holds them.";
  }
  source(scope) {
    return new AppleNotificationCenterSource(void 0, scope);
  }
};
export {
  NotificationCenterConnector as default
};
