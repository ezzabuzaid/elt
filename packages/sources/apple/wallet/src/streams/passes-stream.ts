import type { RecordDraft } from '@workspace/elt';
import { type Pass, passJsonText } from '@workspace/sdk-apple-wallet';

import { AppleWalletStream, walletFields } from '../apple-wallet-stream.ts';

const {
  id,
  text,
  nullableText,
  integer,
  boolean,
  nullableInteger,
  nullableNumber,
  walletInstant,
  passInstant,
  offset,
} = walletFields;

const properties = {
  id: {
    ...id,
    description:
      'passd’s identifier for the pass (pass.unique_id), also the name of its bundle, ~/Library/Passes/Cards/<id>.pkpass. Every other Wallet stream’s passId refers to it.',
  },
  passTypeIdentifier: {
    ...text,
    description:
      'The issuer’s pass type (pass.json passTypeIdentifier), such as pass.com.qatarairways.qrmobile. With serialNumber, the issuer’s identity for the pass; an update keeps both.',
  },
  serialNumber: {
    ...text,
    description:
      'The issuer’s serial number for the pass within its type (serialNumber).',
  },
  teamIdentifier: {
    ...text,
    description:
      'The Apple developer team that signed the pass (teamIdentifier).',
  },
  organizationName: {
    ...text,
    description:
      'The issuer’s name as the pass shows it (organizationName), or its localization key: passLocalizations holds each language’s text.',
  },
  description: {
    ...text,
    description:
      'What the pass is, as VoiceOver reads it (description), such as Qatar Airways Boarding Pass, or its localization key.',
  },
  logoText: {
    ...nullableText,
    description:
      'The text beside the logo (logoText), or its localization key; NULL when the pass shows none.',
  },
  style: {
    type: ['string', 'null'],
    enum: ['boardingPass', 'coupon', 'eventTicket', 'generic', 'storeCard'],
    description:
      'The kind of pass, the pass.json key that holds its fields; NULL for a pass with none of them, such as a payment card.',
  },
  transitType: {
    ...nullableText,
    description:
      'For a boarding pass, how the holder travels (boardingPass.transitType), such as PKTransitTypeAir or PKTransitTypeTrain; NULL otherwise.',
  },
  formatVersion: {
    ...integer,
    description: 'The version of Apple’s pass format (formatVersion); 1.',
  },
  groupingIdentifier: {
    ...nullableText,
    description:
      'Passes of one type with the same value (groupingIdentifier) stack together in Wallet, such as the boarding passes of one booking; NULL when the pass names none.',
  },
  relevantAt: {
    ...passInstant,
    description:
      'When the pass is relevant (relevantDate), such as a departure, in UTC; NULL when it names none. passRelevantDates holds the dates of passes made for iOS 18 and later.',
  },
  relevantAtOffset: {
    ...offset,
    description:
      'The offset from UTC, in minutes, that relevantDate was written with: the local time of the airport or venue. NULL when relevantAt is.',
  },
  expiresAt: {
    ...passInstant,
    description:
      'When the pass expires (expirationDate), in UTC; Wallet then shows it as expired. NULL when it does not expire.',
  },
  expiresAtOffset: {
    ...offset,
    description:
      'The offset from UTC, in minutes, that expirationDate was written with. NULL when expiresAt is.',
  },
  voided: {
    ...boolean,
    description:
      'Whether the issuer voided the pass (voided), such as a used ticket; false when pass.json leaves it out.',
  },
  maxDistance: {
    ...nullableNumber,
    description:
      'How close, in meters, the holder must be to one of passLocations for Wallet to show the pass (maxDistance); NULL for Wallet’s default.',
  },
  associatedStoreIdentifiers: {
    type: ['array', 'null'],
    items: { type: 'integer' },
    description:
      'The App Store IDs of the issuer’s apps (associatedStoreIdentifiers); NULL when the pass names none.',
  },
  appLaunchUrl: {
    ...nullableText,
    description:
      'The URL Wallet passes to the issuer’s app when it opens it from the pass (appLaunchURL); NULL when the pass names none.',
  },
  webServiceUrl: {
    ...nullableText,
    description:
      'The issuer’s web service that sends Wallet new versions of the pass (webServiceURL); NULL when the pass never changes. The token it takes is not loaded.',
  },
  sharingProhibited: {
    ...boolean,
    description:
      'Whether Wallet hides the pass’s share button (sharingProhibited).',
  },
  foregroundColor: {
    ...nullableText,
    description:
      'The color of the pass’s values (foregroundColor), as CSS rgb(); NULL for Wallet’s default.',
  },
  backgroundColor: {
    ...nullableText,
    description:
      'The color of the pass (backgroundColor), as CSS rgb(); NULL for Wallet’s default.',
  },
  labelColor: {
    ...nullableText,
    description:
      'The color of the pass’s labels (labelColor), as CSS rgb(); NULL for Wallet’s default.',
  },
  semantics: {
    ...nullableText,
    description:
      'The pass’s semantic tags (semantics) as JSON, numbers as pass.json spells them: machine-readable facts such as a flight’s airline, airports and departure, an event’s start and venue, or a seat. NULL when the pass carries none.',
  },
  userInfo: {
    ...nullableText,
    description:
      'The issuer’s own data for its app (userInfo) as JSON; NULL when the pass carries none.',
  },
  personalization: {
    ...nullableText,
    description:
      'The bundle’s personalization.json as JSON: the details a reward card asks the holder for to sign up. NULL when the pass asks for none.',
  },
  addedAt: {
    ...walletInstant,
    description:
      'When Wallet on this Mac stored the pass (pass.ingested_date), to the microsecond: when it was added here, or when iCloud brought it from another device.',
  },
  updatedAt: {
    ...walletInstant,
    description:
      'When Wallet stored the version it holds (pass.modified_date), such as an update the issuer sent.',
  },
  signedAt: {
    ...walletInstant,
    description:
      'When the issuer signed the version Wallet holds (pass.signing_date), to the second.',
  },
  archivedAt: {
    ...walletInstant,
    description:
      'When Wallet archived the pass (pass_annotations.archived_timestamp); NULL for a pass it has not archived.',
  },
  sortingState: {
    ...nullableInteger,
    description:
      'passd’s code for where Wallet sorts the pass (pass_annotations.sorting_state); passd’s own predicates use it to split Wallet’s current passes from its expired section. Apple does not document the codes: on macOS 27 it was 0 on passes without archivedAt and 1 on a pass archived as it was added. NULL for a pass with no annotation.',
  },
  passJson: {
    ...text,
    description:
      'The whole pass.json as JSON, numbers as the issuer spelled them, except authenticationToken, the credential the issuer’s web service takes: the fields above under their own keys, and the ones this source does not name.',
  },
} as const;

export class PassesStream extends AppleWalletStream<typeof properties> {
  readonly name = 'passes';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per pass Wallet holds on this Mac: boarding passes, tickets, store and loyalty cards, coupons, as the issuer signed them, with when Wallet added, updated and archived each. Primary key id. A pass the user removes, on this Mac or on a device that syncs Wallet through iCloud, is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected records(pass: Pass): RecordDraft<typeof properties>[] {
    return [
      {
        id: pass.id,
        passTypeIdentifier: pass.passTypeIdentifier,
        serialNumber: pass.serialNumber,
        teamIdentifier: pass.teamIdentifier,
        organizationName: pass.organizationName,
        description: pass.description,
        logoText: pass.logoText,
        style: pass.style,
        transitType: pass.transitType,
        formatVersion: pass.formatVersion,
        groupingIdentifier: pass.groupingIdentifier,
        relevantAt: pass.relevantDate?.at ?? null,
        relevantAtOffset: pass.relevantDate?.offsetMinutes ?? null,
        expiresAt: pass.expirationDate?.at ?? null,
        expiresAtOffset: pass.expirationDate?.offsetMinutes ?? null,
        voided: pass.voided,
        maxDistance: pass.maxDistance,
        associatedStoreIdentifiers: pass.associatedStoreIdentifiers,
        appLaunchUrl: pass.appLaunchUrl,
        webServiceUrl: pass.webServiceUrl,
        sharingProhibited: pass.sharingProhibited,
        foregroundColor: pass.foregroundColor,
        backgroundColor: pass.backgroundColor,
        labelColor: pass.labelColor,
        semantics:
          pass.semantics === null ? null : passJsonText(pass.semantics),
        userInfo: pass.userInfo === null ? null : passJsonText(pass.userInfo),
        personalization:
          pass.personalization === null
            ? null
            : passJsonText(pass.personalization),
        addedAt: pass.addedAt,
        updatedAt: pass.updatedAt,
        signedAt: pass.signedAt,
        archivedAt: pass.archivedAt,
        sortingState: pass.sortingState,
        passJson: passJsonText(pass.json),
      },
    ];
  }
}
