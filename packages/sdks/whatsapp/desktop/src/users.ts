import { Snapshot } from '@zukhruf/sqlite-snapshot';

import { WhatsAppSchemaError, WhatsAppUnavailableError } from './errors.ts';
import { bytes, instant, number, requiredText, text } from './values.ts';

// A WhatsApp user this account has seen, by the LID WhatsApp names them with
// in place of a phone number (LID.sqlite's ZWAZACCOUNT): their phone number
// when they share it, and the names they gave WhatsApp.
export type User = {
  readonly lid: string;
  readonly phoneNumber: string | null;
  readonly countryCode: string | null;
  readonly displayName: string | null;
  readonly username: string | null;
  readonly userType: number | null;
  readonly state: number | null;
  readonly phoneNumberSharingState: number | null;
  readonly usernameState: number | null;
  readonly createdAt: string | null;
  readonly additionalData: Uint8Array | null;
};

const requiredColumns = {
  ZWAZACCOUNT: [
    'Z_PK',
    'ZIDENTIFIER',
    'ZPHONENUMBER',
    'ZCOUNTRYCODE',
    'ZDISPLAYNAME',
    'ZUSERNAME',
    'ZUSERTYPE',
    'ZSTATE',
    'ZCURRENTPHONENUMBERSHARINGSTATE',
    'ZUSERNAMESTATE',
    'ZCREATEDAT',
    'ZADDITIONALDATA',
  ],
};

// LID.sqlite as of one moment.
export class UsersSnapshot implements Disposable {
  readonly #database: Snapshot;

  constructor(path: string) {
    this.#database = new Snapshot(path, WhatsAppUnavailableError);
    this.#database.requireColumns(requiredColumns, WhatsAppSchemaError);
  }

  users(): IteratorObject<User, undefined> {
    return this.#database
      .iterate(
        `SELECT ZIDENTIFIER AS lid, ZPHONENUMBER AS phoneNumber,
                ZCOUNTRYCODE AS countryCode, ZDISPLAYNAME AS displayName,
                ZUSERNAME AS username, ZUSERTYPE AS userType, ZSTATE AS state,
                ZCURRENTPHONENUMBERSHARINGSTATE AS phoneNumberSharingState,
                ZUSERNAMESTATE AS usernameState, ZCREATEDAT AS createdAt,
                ZADDITIONALDATA AS additionalData
         FROM ZWAZACCOUNT ORDER BY Z_PK`,
      )
      .map((row) => ({
        lid: requiredText(row.lid, 'A WhatsApp user has no LID'),
        phoneNumber: text(row.phoneNumber),
        countryCode: text(row.countryCode),
        displayName: text(row.displayName),
        username: text(row.username),
        userType: number(row.userType),
        state: number(row.state),
        phoneNumberSharingState: number(row.phoneNumberSharingState),
        usernameState: number(row.usernameState),
        createdAt: instant(row.createdAt),
        additionalData: bytes(row.additionalData),
      }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}
