// Apple binary property lists (bplist00) and NSKeyedArchiver graphs, as
// Messages stores them. Values decode to JSON-shaped data: Data becomes a
// Uint8Array, dates Date, integers beyond 2^53 bigint.

export type PlistValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Date
  | Uint8Array
  | PlistUid
  | PlistValue[]
  | { [key: string]: PlistValue };

export class PlistUid {
  constructor(readonly value: number) {}
}

const appleEpoch = Date.UTC(2001, 0, 1);

export function isBinaryPlist(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 40 &&
    new TextDecoder('latin1').decode(bytes.subarray(0, 8)) === 'bplist00'
  );
}

export function parseBinaryPlist(bytes: Uint8Array): PlistValue {
  if (!isBinaryPlist(bytes)) throw new TypeError('Not a binary property list');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trailer = bytes.length - 32;
  const offsetSize = view.getUint8(trailer + 6);
  const referenceSize = view.getUint8(trailer + 7);
  const count = Number(view.getBigUint64(trailer + 8));
  const top = Number(view.getBigUint64(trailer + 16));
  const offsetTable = Number(view.getBigUint64(trailer + 24));
  const unsigned = (at: number, size: number): number => {
    let value = 0;
    for (let index = 0; index < size; index++)
      value = value * 256 + view.getUint8(at + index);
    return value;
  };
  const offsetOf = (reference: number) => {
    if (reference >= count)
      throw new TypeError('Property list references a missing object');
    return unsigned(offsetTable + reference * offsetSize, offsetSize);
  };
  // A length in the marker's low nibble, or 0xF and an integer object after it.
  const lengthAt = (at: number): [length: number, start: number] => {
    const nibble = view.getUint8(at) & 0x0f;
    if (nibble !== 0x0f) return [nibble, at + 1];
    const size = 1 << (view.getUint8(at + 1) & 0x0f);
    return [unsigned(at + 2, size), at + 2 + size];
  };
  const decoding = new Set<number>();
  const object = (reference: number): PlistValue => {
    if (decoding.has(reference))
      throw new TypeError('Property list contains a cycle');
    decoding.add(reference);
    try {
      return read(offsetOf(reference));
    } finally {
      decoding.delete(reference);
    }
  };
  const read = (at: number): PlistValue => {
    const marker = view.getUint8(at);
    const kind = marker >> 4;
    const nibble = marker & 0x0f;
    switch (kind) {
      case 0x0:
        if (marker === 0x00) return null;
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        break;
      case 0x1: {
        const size = 1 << nibble;
        if (size === 8) {
          const value = view.getBigInt64(at + 1);
          return Number.isSafeInteger(Number(value)) ? Number(value) : value;
        }
        if (size === 16) return view.getBigInt64(at + 9);
        return unsigned(at + 1, size);
      }
      case 0x2:
        return nibble === 2 ? view.getFloat32(at + 1) : view.getFloat64(at + 1);
      case 0x3:
        return new Date(appleEpoch + view.getFloat64(at + 1) * 1000);
      case 0x4: {
        const [length, start] = lengthAt(at);
        // A plain copy: a Buffer would serialize through Buffer#toJSON.
        return new Uint8Array(bytes.subarray(start, start + length));
      }
      case 0x5: {
        const [length, start] = lengthAt(at);
        return new TextDecoder('latin1').decode(
          bytes.subarray(start, start + length),
        );
      }
      case 0x6: {
        const [length, start] = lengthAt(at);
        let text = '';
        for (let index = 0; index < length; index++)
          text += String.fromCharCode(view.getUint16(start + index * 2));
        return text;
      }
      case 0x8:
        return new PlistUid(unsigned(at + 1, nibble + 1));
      case 0xa:
      case 0xc: {
        const [length, start] = lengthAt(at);
        return Array.from({ length }, (_, index) =>
          object(unsigned(start + index * referenceSize, referenceSize)),
        );
      }
      case 0xd: {
        const [length, start] = lengthAt(at);
        const entries: { [key: string]: PlistValue } = {};
        for (let index = 0; index < length; index++) {
          const key = object(
            unsigned(start + index * referenceSize, referenceSize),
          );
          if (typeof key !== 'string')
            throw new TypeError('Property list dictionary key is not a string');
          entries[key] = object(
            unsigned(start + (length + index) * referenceSize, referenceSize),
          );
        }
        return entries;
      }
    }
    throw new TypeError(
      `Unsupported property list marker 0x${marker.toString(16)}`,
    );
  };
  return object(top);
}

// Rebuilds an NSKeyedArchiver object graph: Foundation collections, strings,
// data, dates, URLs and UUIDs become plain values; any other class becomes an
// object with its fields and "$class". A repeated object is decoded again.
export function unarchive(archive: PlistValue): PlistValue {
  if (
    !isRecord(archive) ||
    archive.$archiver !== 'NSKeyedArchiver' ||
    !Array.isArray(archive.$objects) ||
    !isRecord(archive.$top)
  )
    throw new TypeError('Not an NSKeyedArchiver archive');
  const objects = archive.$objects;
  const resolving = new Set<number>();
  const resolve = (value: PlistValue): PlistValue => {
    if (value instanceof PlistUid) {
      if (resolving.has(value.value)) return { $ref: value.value };
      resolving.add(value.value);
      try {
        const target = objects[value.value];
        return target === '$null' || target === undefined
          ? null
          : resolve(target);
      } finally {
        resolving.delete(value.value);
      }
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (!isRecord(value)) return value;
    const className = isUid(value.$class)
      ? classNameOf(objects[value.$class.value])
      : undefined;
    if (className === undefined)
      return Object.fromEntries(
        Object.entries(value).map(([key, field]) => [key, resolve(field)]),
      );
    return decodeClass(className, value, resolve);
  };
  const top = archive.$top;
  const root = 'root' in top ? top.root : top;
  return resolve(root as PlistValue);
}

function decodeClass(
  className: string,
  value: { [key: string]: PlistValue },
  resolve: (value: PlistValue) => PlistValue,
): PlistValue {
  switch (className) {
    case 'NSDictionary':
    case 'NSMutableDictionary': {
      const keys = asArray(value['NS.keys']).map(resolve);
      const values = asArray(value['NS.objects']).map(resolve);
      return Object.fromEntries(
        keys.map((key, index) => [String(key), values[index] ?? null]),
      );
    }
    case 'NSArray':
    case 'NSMutableArray':
    case 'NSSet':
    case 'NSMutableSet':
    case 'NSOrderedSet':
    case 'NSMutableOrderedSet':
      return asArray(value['NS.objects']).map(resolve);
    case 'NSString':
    case 'NSMutableString':
      return resolve(value['NS.string'] ?? null);
    case 'NSData':
    case 'NSMutableData':
      return resolve(value['NS.data'] ?? null);
    case 'NSDate':
      return new Date(appleEpoch + Number(value['NS.time']) * 1000);
    case 'NSURL': {
      const relative = String(resolve(value['NS.relative'] ?? null));
      const base = resolve(value['NS.base'] ?? null);
      return typeof base === 'string' ? new URL(relative, base).href : relative;
    }
    case 'NSUUID': {
      const hex = Buffer.from(value['NS.uuidbytes'] as Uint8Array).toString(
        'hex',
      );
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase();
    }
  }
  const fields: { [key: string]: PlistValue } = { $class: className };
  for (const [key, field] of Object.entries(value))
    if (key !== '$class') fields[key] = resolve(field);
  return fields;
}

// A plist value as JSON text: bytes as base64, dates as ISO, big integers as strings.
export function plistJSON(value: PlistValue): string {
  return JSON.stringify(value, (_, field: unknown) =>
    field instanceof Uint8Array
      ? Buffer.from(field).toString('base64')
      : typeof field === 'bigint'
        ? field.toString()
        : field instanceof PlistUid
          ? { $uid: field.value }
          : field,
  );
}

// Decodes a stored archive, unarchiving keyed ones.
export function decodeArchive(bytes: Uint8Array): PlistValue {
  const value = parseBinaryPlist(bytes);
  return isRecord(value) && value.$archiver === 'NSKeyedArchiver'
    ? unarchive(value)
    : value;
}

function isRecord(value: unknown): value is { [key: string]: PlistValue } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date) &&
    !(value instanceof PlistUid)
  );
}

function isUid(value: unknown): value is PlistUid {
  return value instanceof PlistUid;
}

function asArray(value: PlistValue | undefined): PlistValue[] {
  return Array.isArray(value) ? value : [];
}

function classNameOf(value: PlistValue | undefined): string | undefined {
  return isRecord(value) && typeof value.$classname === 'string'
    ? value.$classname
    : undefined;
}
