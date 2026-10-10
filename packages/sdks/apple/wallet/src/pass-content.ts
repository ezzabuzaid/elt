import {
  type PassJson,
  PassNumber,
  isPassList,
  isPassObject,
} from './pass-json.ts';
import {
  type PassBarcode,
  type PassBeacon,
  type PassContent,
  type PassDate,
  type PassField,
  type PassLocation,
  type PassRelevantDate,
  passStyles,
} from './pass.ts';

type PassObject = { readonly [key: string]: PassJson };

// A W3C date as PassKit takes it: minutes required, seconds and milliseconds
// optional, and a time zone.
const w3cDate =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):?(\d{2}))$/;

// The keys of one pass.json object read as what Apple's pass format says they
// hold, naming the key whose value is of another kind.
class PassReader {
  readonly #object: PassObject;
  readonly #path: string;

  constructor(object: PassObject, path: string) {
    this.#object = object;
    this.#path = path;
  }

  has(key: string): boolean {
    return this.#object[key] !== undefined && this.#object[key] !== null;
  }

  text(key: string): string | null {
    const value = this.#object[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw this.#wrong(key, 'text');
    return value;
  }

  requiredText(key: string): string {
    return this.text(key) ?? this.#missing(key);
  }

  // Text or a number, as pass.json spells it.
  value(key: string): string | null {
    const value = this.#object[key];
    if (value instanceof PassNumber) return value.text;
    return this.text(key);
  }

  requiredValue(key: string): string {
    return this.value(key) ?? this.#missing(key);
  }

  flag(key: string): boolean {
    const value = this.#object[key];
    if (value === undefined || value === null) return false;
    if (typeof value !== 'boolean') throw this.#wrong(key, 'a boolean');
    return value;
  }

  number(key: string): number | null {
    const value = this.#object[key];
    if (value === undefined || value === null) return null;
    if (!(value instanceof PassNumber)) throw this.#wrong(key, 'a number');
    return Number(value.text);
  }

  requiredNumber(key: string): number {
    return this.number(key) ?? this.#missing(key);
  }

  integer(key: string): number | null {
    const value = this.number(key);
    if (value !== null && !Number.isSafeInteger(value))
      throw this.#wrong(key, 'an integer');
    return value;
  }

  requiredInteger(key: string): number {
    return this.integer(key) ?? this.#missing(key);
  }

  date(key: string): PassDate | null {
    const text = this.text(key);
    return text === null ? null : this.#date(key, text);
  }

  json(key: string): PassJson | null {
    return this.#object[key] ?? null;
  }

  texts(key: string): readonly string[] | null {
    if (!this.has(key)) return null;
    return this.#list(key).map((item, index) => {
      if (typeof item !== 'string')
        throw this.#wrong(`${key}[${index}]`, 'text');
      return item;
    });
  }

  integers(key: string): readonly number[] | null {
    if (!this.has(key)) return null;
    return this.#list(key).map((item, index) => {
      const value = item instanceof PassNumber ? Number(item.text) : null;
      if (value === null || !Number.isSafeInteger(value))
        throw this.#wrong(`${key}[${index}]`, 'an integer');
      return value;
    });
  }

  object(key: string): PassReader {
    const value = this.#object[key];
    if (!isPassObject(value)) throw this.#wrong(key, 'an object');
    return new PassReader(value, `${this.#path}.${key}`);
  }

  objects(key: string): PassReader[] {
    if (!this.has(key)) return [];
    return this.#list(key).map((item, index) => {
      if (!isPassObject(item))
        throw this.#wrong(`${key}[${index}]`, 'an object');
      return new PassReader(item, `${this.#path}.${key}[${index}]`);
    });
  }

  // The keys that name an area of fields, such as primaryFields.
  fieldAreas(): string[] {
    return Object.keys(this.#object).filter(
      (key) => key.endsWith('Fields') && isPassList(this.#object[key]),
    );
  }

  #list(key: string): readonly PassJson[] {
    const value = this.#object[key];
    if (!isPassList(value)) throw this.#wrong(key, 'a list');
    return value;
  }

  #date(key: string, text: string): PassDate {
    const match = w3cDate.exec(text);
    if (match === null) throw this.#wrong(key, 'a W3C date with a time zone');
    // An absent part reads as '', which Number takes as 0.
    const [year, month, day, hour, minute, second, fraction] = match
      .slice(1, 8)
      .map((part) => part ?? '');
    const sign = match[8] === '-' ? -1 : 1;
    const offsetMinutes =
      match[8] === undefined
        ? 0
        : sign * (Number(match[9]) * 60 + Number(match[10]));
    const wall = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(fraction?.padEnd(3, '0')),
    );
    // Date.UTC rolls an impossible day, such as February 30, into the next
    // month.
    if (
      new Date(wall).toISOString().slice(0, 16) !==
      `${year}-${month}-${day}T${hour}:${minute}`
    )
      throw this.#wrong(key, 'a calendar date');
    return {
      at: new Date(wall - offsetMinutes * 60_000).toISOString(),
      offsetMinutes,
    };
  }

  #missing(key: string): never {
    throw new TypeError(`${this.#path}.${key} is missing`);
  }

  #wrong(key: string, kind: string): TypeError {
    return new TypeError(`${this.#path}.${key} is not ${kind}`);
  }
}

// A pass as its pass.json describes it, with every key read as Apple's pass
// format defines it.
export function passContent(json: PassJson): PassContent {
  if (!isPassObject(json)) throw new TypeError('pass.json is not an object');
  const pass = new PassReader(json, 'pass.json');
  const style = passStyles.find((name) => isPassObject(json[name])) ?? null;
  const structure = style === null ? null : pass.object(style);
  return {
    passTypeIdentifier: pass.requiredText('passTypeIdentifier'),
    serialNumber: pass.requiredText('serialNumber'),
    teamIdentifier: pass.requiredText('teamIdentifier'),
    organizationName: pass.requiredText('organizationName'),
    description: pass.requiredText('description'),
    formatVersion: pass.requiredInteger('formatVersion'),
    logoText: pass.text('logoText'),
    style,
    transitType: structure?.text('transitType') ?? null,
    groupingIdentifier: pass.text('groupingIdentifier'),
    relevantDate: pass.date('relevantDate'),
    expirationDate: pass.date('expirationDate'),
    voided: pass.flag('voided'),
    maxDistance: pass.number('maxDistance'),
    associatedStoreIdentifiers: pass.integers('associatedStoreIdentifiers'),
    appLaunchUrl: pass.text('appLaunchURL'),
    webServiceUrl: pass.text('webServiceURL'),
    sharingProhibited: pass.flag('sharingProhibited'),
    foregroundColor: pass.text('foregroundColor'),
    backgroundColor: pass.text('backgroundColor'),
    labelColor: pass.text('labelColor'),
    semantics: pass.json('semantics'),
    userInfo: pass.json('userInfo'),
    fields: structure === null ? [] : fields(structure),
    barcodes: barcodes(pass),
    locations: pass.objects('locations').map(location),
    beacons: pass.objects('beacons').map(beacon),
    relevantDates: pass.objects('relevantDates').map(relevantDate),
    json: Object.fromEntries(
      Object.entries(json).filter(([key]) => key !== 'authenticationToken'),
    ),
  };
}

function fields(structure: PassReader): PassField[] {
  return structure.fieldAreas().flatMap((key) =>
    structure.objects(key).map((field, position): PassField => ({
      area: key.slice(0, -'Fields'.length),
      position,
      key: field.requiredText('key'),
      label: field.text('label'),
      value: field.requiredValue('value'),
      attributedValue: field.value('attributedValue'),
      changeMessage: field.text('changeMessage'),
      textAlignment: field.text('textAlignment'),
      dateStyle: field.text('dateStyle'),
      timeStyle: field.text('timeStyle'),
      ignoresTimeZone: field.flag('ignoresTimeZone'),
      isRelative: field.flag('isRelative'),
      numberStyle: field.text('numberStyle'),
      currencyCode: field.text('currencyCode'),
      dataDetectorTypes: field.texts('dataDetectorTypes'),
      row: field.integer('row'),
      semantics: field.json('semantics'),
    })),
  );
}

// PassKit shows the first barcode of barcodes it can draw; barcode, which
// iOS 9 replaced, counts only when barcodes is absent.
function barcodes(pass: PassReader): PassBarcode[] {
  return barcodeReaders(pass).map((barcode, position) => ({
    position,
    format: barcode.requiredText('format'),
    message: barcode.requiredText('message'),
    messageEncoding: barcode.requiredText('messageEncoding'),
    altText: barcode.text('altText'),
  }));
}

function barcodeReaders(pass: PassReader): PassReader[] {
  if (pass.has('barcodes')) return pass.objects('barcodes');
  if (pass.has('barcode')) return [pass.object('barcode')];
  return [];
}

function location(location: PassReader, position: number): PassLocation {
  return {
    position,
    latitude: location.requiredNumber('latitude'),
    longitude: location.requiredNumber('longitude'),
    altitude: location.number('altitude'),
    relevantText: location.text('relevantText'),
  };
}

function beacon(beacon: PassReader, position: number): PassBeacon {
  return {
    position,
    proximityUuid: beacon.requiredText('proximityUUID'),
    major: beacon.integer('major'),
    minor: beacon.integer('minor'),
    relevantText: beacon.text('relevantText'),
  };
}

function relevantDate(
  relevant: PassReader,
  position: number,
): PassRelevantDate {
  return {
    position,
    date: relevant.date('date'),
    startDate: relevant.date('startDate'),
    endDate: relevant.date('endDate'),
  };
}
