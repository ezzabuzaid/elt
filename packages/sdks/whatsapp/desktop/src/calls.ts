import {
  AppDatabase,
  type AppDatabaseColumns,
} from '@workspace/sdk-apple-app-database';

import { WhatsAppSchemaError, WhatsAppUnavailableError } from './errors.ts';
import { flag, instant, number, requiredText, text } from './values.ts';

// One WhatsApp call (ZWACDCALLEVENT) with the call-log entry that groups it
// (ZWAAGGREGATECALLEVENT), whose direction, missed state and video apply to
// every call in it.
export type Call = {
  readonly callId: string;
  readonly date: string | null;
  readonly duration: number | null;
  readonly outcome: number | null;
  readonly bytesSent: number | null;
  readonly bytesReceived: number | null;
  readonly groupJid: string | null;
  readonly groupCallCreatorJid: string | null;
  readonly isBotGroupCall: boolean | null;
  readonly isLightweight: boolean | null;
  readonly reminderId: string | null;
  readonly scheduledId: string | null;
  readonly incoming: boolean | null;
  readonly missed: boolean | null;
  readonly missedReason: number | null;
  readonly video: boolean | null;
  readonly firstDate: string | null;
  readonly linkToken: string | null;
};

// Another party on a call, and how the call ended for them. WhatsApp keeps
// participants on the call-log entry, so each call of an entry has them all.
export type CallParticipant = {
  readonly callId: string;
  readonly jid: string;
  readonly outcome: number | null;
};

const requiredColumns = {
  ZWACDCALLEVENT: [
    'Z_PK',
    'ZCALLIDSTRING',
    'ZDATE',
    'ZDURATION',
    'ZOUTCOME',
    'ZBYTESSENT',
    'ZBYTESRECEIVED',
    'ZGROUPJIDSTRING',
    'ZGROUPCALLCREATORUSERJIDSTRING',
    'ZISBOTGROUPCALL',
    'ZISLIGHTWEIGHT',
    'ZREMINDERID',
    'ZSCHEDULEDID',
  ],
  ZWAAGGREGATECALLEVENT: [
    'Z_PK',
    'ZINCOMING',
    'ZMISSED',
    'ZMISSEDREASON',
    'ZVIDEO',
    'ZFIRSTDATE',
    'ZLINKTOKEN',
  ],
  ZWACDCALLEVENTPARTICIPANT: ['Z_PK', 'ZJIDSTRING', 'ZOUTCOME'],
} satisfies AppDatabaseColumns;

// CallHistory.sqlite as of one moment, so a call and its participants agree.
export class CallsSnapshot implements Disposable {
  readonly #database: AppDatabase;
  readonly #callLog: string;
  readonly #participantLog: string;

  constructor(path: string) {
    this.#database = new AppDatabase(path, WhatsAppUnavailableError);
    this.#database.requireColumns(requiredColumns, WhatsAppSchemaError);
    try {
      this.#callLog = this.#relationship('ZWACDCALLEVENT', 'CALLEVENTS');
      this.#participantLog = this.#relationship(
        'ZWACDCALLEVENTPARTICIPANT',
        'PARTICIPANTS',
      );
    } catch (error) {
      this.#database[Symbol.dispose]();
      throw error;
    }
  }

  calls(): Call[] {
    return this.#database
      .all(
        `SELECT call.ZCALLIDSTRING AS callId, call.ZDATE AS date,
                call.ZDURATION AS duration, call.ZOUTCOME AS outcome,
                call.ZBYTESSENT AS bytesSent,
                call.ZBYTESRECEIVED AS bytesReceived,
                call.ZGROUPJIDSTRING AS groupJid,
                call.ZGROUPCALLCREATORUSERJIDSTRING AS groupCallCreatorJid,
                call.ZISBOTGROUPCALL AS isBotGroupCall,
                call.ZISLIGHTWEIGHT AS isLightweight,
                call.ZREMINDERID AS reminderId,
                call.ZSCHEDULEDID AS scheduledId, log.ZINCOMING AS incoming,
                log.ZMISSED AS missed, log.ZMISSEDREASON AS missedReason,
                log.ZVIDEO AS video, log.ZFIRSTDATE AS firstDate,
                log.ZLINKTOKEN AS linkToken
         FROM ZWACDCALLEVENT AS call
         LEFT JOIN ZWAAGGREGATECALLEVENT AS log
           ON log.Z_PK = call."${this.#callLog}"
         ORDER BY call.Z_PK`,
      )
      .map((row) => ({
        callId: requiredText(row.callId, 'A WhatsApp call has no ID'),
        date: instant(row.date),
        duration: number(row.duration),
        outcome: number(row.outcome),
        bytesSent: number(row.bytesSent),
        bytesReceived: number(row.bytesReceived),
        groupJid: text(row.groupJid),
        groupCallCreatorJid: text(row.groupCallCreatorJid),
        isBotGroupCall: flag(row.isBotGroupCall),
        isLightweight: flag(row.isLightweight),
        reminderId: text(row.reminderId),
        scheduledId: text(row.scheduledId),
        incoming: flag(row.incoming),
        missed: flag(row.missed),
        missedReason: number(row.missedReason),
        video: flag(row.video),
        firstDate: instant(row.firstDate),
        linkToken: text(row.linkToken),
      }));
  }

  participants(): CallParticipant[] {
    return this.#database
      .all(
        `SELECT call.ZCALLIDSTRING AS callId, participant.ZJIDSTRING AS jid,
                participant.ZOUTCOME AS outcome
         FROM ZWACDCALLEVENTPARTICIPANT AS participant
         JOIN ZWACDCALLEVENT AS call
           ON call."${this.#callLog}" = participant."${this.#participantLog}"
         ORDER BY participant.Z_PK, call.Z_PK`,
      )
      .map((row) => ({
        callId: requiredText(row.callId, 'A WhatsApp call has no ID'),
        jid: requiredText(row.jid, 'A WhatsApp call participant has no JID'),
        outcome: number(row.outcome),
      }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }

  // The call-log entry's calls and participants are to-many relationships
  // with no inverse, which Core Data keeps as a column on each call and
  // participant named after the entry's entity number and the relationship
  // (Z1CALLEVENTS, Z1PARTICIPANTS). The number changes between model
  // versions, so the column is found by the end of its name; Z_FOK_ columns
  // only order the relationship.
  #relationship(table: string, name: string): string {
    const found = this.#database
      .all('SELECT name FROM pragma_table_info(?)', table)
      .map((column) => String(column.name))
      .filter((column) => /^Z\d+/.test(column) && column.endsWith(name));
    const [column] = found;
    if (column === undefined || found.length !== 1)
      throw new WhatsAppSchemaError(this.#database.path, [
        `${table}.Z*${name}`,
      ]);
    return column;
  }
}
