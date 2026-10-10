import type { PassJson } from './pass-json.ts';

// The top-level pass.json key that holds a pass's fields names its style.
export type PassStyle =
  'boardingPass' | 'coupon' | 'eventTicket' | 'generic' | 'storeCard';

export const passStyles: readonly PassStyle[] = [
  'boardingPass',
  'coupon',
  'eventTicket',
  'generic',
  'storeCard',
];

// A moment pass.json names, such as a flight's departure: the UTC instant to
// the millisecond, and the offset from UTC in minutes the issuer wrote it
// with, the local time of an airport or a venue.
export type PassDate = {
  readonly at: string;
  readonly offsetMinutes: number;
};

// What Wallet records about a pass in passes23.sqlite, beside its bundle.
export type WalletRecord = {
  // passd's identifier for the pass; Cards/<id>.pkpass is its bundle.
  readonly id: string;
  readonly addedAt: string | null;
  // When Wallet last stored a new version of the pass.
  readonly updatedAt: string | null;
  // When the issuer signed the version Wallet holds.
  readonly signedAt: string | null;
  readonly archivedAt: string | null;
  // passd's code for where Wallet sorts the pass: its stack of current passes
  // or the expired section; Apple does not document the codes.
  readonly sortingState: number | null;
};

// One field a pass shows, in pass.json's order within its area. Text a pass
// localizes is its localization key: PassString holds each language's text.
export type PassField = {
  // The pass.json array it is in, without "Fields": header, primary,
  // secondary, auxiliary, back or additionalInfo.
  readonly area: string;
  readonly position: number;
  readonly key: string;
  readonly label: string | null;
  // As pass.json writes it: text, a number's digits, or a W3C date.
  readonly value: string;
  readonly attributedValue: string | null;
  readonly changeMessage: string | null;
  readonly textAlignment: string | null;
  readonly dateStyle: string | null;
  readonly timeStyle: string | null;
  readonly ignoresTimeZone: boolean;
  readonly isRelative: boolean;
  readonly numberStyle: string | null;
  readonly currencyCode: string | null;
  readonly dataDetectorTypes: readonly string[] | null;
  readonly row: number | null;
  readonly semantics: PassJson | null;
};

export type PassBarcode = {
  readonly position: number;
  readonly format: string;
  readonly message: string;
  readonly messageEncoding: string;
  readonly altText: string | null;
};

export type PassLocation = {
  readonly position: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude: number | null;
  readonly relevantText: string | null;
};

export type PassBeacon = {
  readonly position: number;
  readonly proximityUuid: string;
  readonly major: number | null;
  readonly minor: number | null;
  readonly relevantText: string | null;
};

// A time the pass is relevant: one moment, or an interval.
export type PassRelevantDate = {
  readonly position: number;
  readonly date: PassDate | null;
  readonly startDate: PassDate | null;
  readonly endDate: PassDate | null;
};

// The pass as its issuer signed it, from pass.json.
export type PassContent = {
  readonly passTypeIdentifier: string;
  readonly serialNumber: string;
  readonly teamIdentifier: string;
  readonly organizationName: string;
  readonly description: string;
  readonly formatVersion: number;
  readonly logoText: string | null;
  readonly style: PassStyle | null;
  readonly transitType: string | null;
  readonly groupingIdentifier: string | null;
  readonly relevantDate: PassDate | null;
  readonly expirationDate: PassDate | null;
  readonly voided: boolean;
  readonly maxDistance: number | null;
  readonly associatedStoreIdentifiers: readonly number[] | null;
  readonly appLaunchUrl: string | null;
  readonly webServiceUrl: string | null;
  readonly sharingProhibited: boolean;
  readonly foregroundColor: string | null;
  readonly backgroundColor: string | null;
  readonly labelColor: string | null;
  readonly semantics: PassJson | null;
  readonly userInfo: PassJson | null;
  readonly fields: readonly PassField[];
  readonly barcodes: readonly PassBarcode[];
  readonly locations: readonly PassLocation[];
  readonly beacons: readonly PassBeacon[];
  readonly relevantDates: readonly PassRelevantDate[];
  // pass.json whole, but its authenticationToken: the credential the
  // issuer's web service takes to update or unregister the pass.
  readonly json: PassJson;
};

// A localization a pass bundle carries: <language>.lproj/pass.strings.
export type PassString = {
  readonly language: string;
  readonly key: string;
  readonly text: string;
};

// An image a pass bundle carries, as its signed manifest lists it.
export type PassImage = {
  // Its path in the bundle, such as en.lproj/logo@2x.png.
  readonly path: string;
  // The file in the bundle Wallet keeps.
  readonly file: string;
  // icon, logo, strip, thumbnail, background, footer or another name.
  readonly name: string;
  readonly scale: number;
  readonly language: string | null;
  // The SHA-1 the manifest gives it, which changes with the image.
  readonly sha1: string;
};

// The files of a pass bundle besides pass.json.
export type PassAssets = {
  readonly strings: readonly PassString[];
  readonly images: readonly PassImage[];
  // personalization.json, the fields a reward card asks the user to fill.
  readonly personalization: PassJson | null;
};

export type Pass = WalletRecord & PassContent & PassAssets;
