import { type Snapshot } from '@zukhruf/sqlite-snapshot';

import { appDatabase } from './app-database.ts';
import { instant, number, requiredText, text } from './values.ts';

// A person in the Mac's address book whom WhatsApp found on WhatsApp, one per
// phone number (ZWAADDRESSBOOKCONTACT).
export type AddressBookContact = {
  readonly uniqueId: string;
  readonly whatsappId: string | null;
  readonly lid: string | null;
  readonly interopJid: string | null;
  readonly identifier: string | null;
  readonly fullName: string | null;
  readonly givenName: string | null;
  readonly lastName: string | null;
  readonly businessName: string | null;
  readonly highlightedName: string | null;
  readonly username: string | null;
  readonly phoneNumber: string | null;
  readonly localizedPhoneNumber: string | null;
  readonly phoneNumberLabel: string | null;
  readonly phoneStatus: number | null;
  readonly aboutText: string | null;
  readonly aboutEmoji: string | null;
  readonly aboutTimestamp: string | null;
  readonly aboutExpirationTimestamp: string | null;
  readonly notes: string | null;
  readonly disappearingModeDuration: number | null;
  readonly disappearingModeTimestamp: string | null;
  readonly source: number | null;
  readonly syncPolicy: number | null;
  readonly lastUpdated: string | null;
};

// Left out: search tokens, sort keys and section titles WhatsApp's list uses,
// the hashes it matches numbers by, its sync state and the contact's device
// list.
const requiredColumns = {
  ZWAADDRESSBOOKCONTACT: [
    'Z_PK',
    'ZUNIQUEID',
    'ZWHATSAPPID',
    'ZLID',
    'ZINTEROPJID',
    'ZIDENTIFIER',
    'ZFULLNAME',
    'ZGIVENNAME',
    'ZLASTNAME',
    'ZBUSINESSNAME',
    'ZHIGHLIGHTEDNAME',
    'ZUSERNAME',
    'ZPHONENUMBER',
    'ZLOCALIZEDPHONENUMBER',
    'ZPHONENUMBERLABEL',
    'ZPHONESTATUS',
    'ZABOUTTEXT',
    'ZABOUTEMOJI',
    'ZABOUTTIMESTAMP',
    'ZABOUTEXPIRATIONTIMESTAMP',
    'ZNOTES',
    'ZDISAPPEARINGMODEDURATION',
    'ZDISAPPEARINGMODETIMESTAMP',
    'ZSOURCE',
    'ZSYNCPOLICY',
    'ZLASTUPDATED',
  ],
};

// ContactsV2.sqlite as of one moment.
export class ContactsSnapshot implements Disposable {
  readonly #database: Snapshot;

  constructor(path: string) {
    this.#database = appDatabase.snapshot(path, requiredColumns);
  }

  contacts(): IteratorObject<AddressBookContact, undefined> {
    return this.#database
      .iterate(
        `SELECT ZUNIQUEID AS uniqueId, ZWHATSAPPID AS whatsappId, ZLID AS lid,
                ZINTEROPJID AS interopJid, ZIDENTIFIER AS identifier,
                ZFULLNAME AS fullName, ZGIVENNAME AS givenName,
                ZLASTNAME AS lastName, ZBUSINESSNAME AS businessName,
                ZHIGHLIGHTEDNAME AS highlightedName, ZUSERNAME AS username,
                ZPHONENUMBER AS phoneNumber,
                ZLOCALIZEDPHONENUMBER AS localizedPhoneNumber,
                ZPHONENUMBERLABEL AS phoneNumberLabel,
                ZPHONESTATUS AS phoneStatus, ZABOUTTEXT AS aboutText,
                ZABOUTEMOJI AS aboutEmoji, ZABOUTTIMESTAMP AS aboutTimestamp,
                ZABOUTEXPIRATIONTIMESTAMP AS aboutExpirationTimestamp,
                ZNOTES AS notes,
                ZDISAPPEARINGMODEDURATION AS disappearingModeDuration,
                ZDISAPPEARINGMODETIMESTAMP AS disappearingModeTimestamp,
                ZSOURCE AS source, ZSYNCPOLICY AS syncPolicy,
                ZLASTUPDATED AS lastUpdated
         FROM ZWAADDRESSBOOKCONTACT ORDER BY Z_PK`,
      )
      .map((row) => ({
        uniqueId: requiredText(row.uniqueId, 'A WhatsApp contact has no ID'),
        whatsappId: text(row.whatsappId),
        lid: text(row.lid),
        interopJid: text(row.interopJid),
        identifier: text(row.identifier),
        fullName: text(row.fullName),
        givenName: text(row.givenName),
        lastName: text(row.lastName),
        businessName: text(row.businessName),
        highlightedName: text(row.highlightedName),
        username: text(row.username),
        phoneNumber: text(row.phoneNumber),
        localizedPhoneNumber: text(row.localizedPhoneNumber),
        phoneNumberLabel: text(row.phoneNumberLabel),
        phoneStatus: number(row.phoneStatus),
        aboutText: text(row.aboutText),
        aboutEmoji: text(row.aboutEmoji),
        aboutTimestamp: instant(row.aboutTimestamp),
        aboutExpirationTimestamp: instant(row.aboutExpirationTimestamp),
        notes: text(row.notes),
        disappearingModeDuration: number(row.disappearingModeDuration),
        disappearingModeTimestamp: instant(row.disappearingModeTimestamp),
        source: number(row.source),
        syncPolicy: number(row.syncPolicy),
        lastUpdated: instant(row.lastUpdated),
      }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}
