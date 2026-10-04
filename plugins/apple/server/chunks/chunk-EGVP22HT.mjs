import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// packages/sources/apple/macos/dist/plist.js
var PlistUid = class {
  value;
  constructor(value) {
    this.value = value;
  }
};
var appleEpoch = Date.UTC(2001, 0, 1);
function isBinaryPlist(bytes) {
  return bytes.length >= 40 && new TextDecoder("latin1").decode(bytes.subarray(0, 8)) === "bplist00";
}
function parseBinaryPlist(bytes) {
  if (!isBinaryPlist(bytes))
    throw new TypeError("Not a binary property list");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trailer = bytes.length - 32;
  const offsetSize = view.getUint8(trailer + 6);
  const referenceSize = view.getUint8(trailer + 7);
  const count = Number(view.getBigUint64(trailer + 8));
  const top = Number(view.getBigUint64(trailer + 16));
  const offsetTable = Number(view.getBigUint64(trailer + 24));
  const unsigned = (at, size) => {
    let value = 0;
    for (let index = 0; index < size; index++)
      value = value * 256 + view.getUint8(at + index);
    return value;
  };
  const offsetOf = (reference) => {
    if (reference >= count)
      throw new TypeError("Property list references a missing object");
    return unsigned(offsetTable + reference * offsetSize, offsetSize);
  };
  const lengthAt = (at) => {
    const nibble = view.getUint8(at) & 15;
    if (nibble !== 15)
      return [nibble, at + 1];
    const size = 1 << (view.getUint8(at + 1) & 15);
    return [unsigned(at + 2, size), at + 2 + size];
  };
  const decoding = /* @__PURE__ */ new Set();
  const object = (reference) => {
    if (decoding.has(reference))
      throw new TypeError("Property list contains a cycle");
    decoding.add(reference);
    try {
      return read(offsetOf(reference));
    } finally {
      decoding.delete(reference);
    }
  };
  const read = (at) => {
    const marker = view.getUint8(at);
    const kind = marker >> 4;
    const nibble = marker & 15;
    switch (kind) {
      case 0:
        if (marker === 0)
          return null;
        if (marker === 8)
          return false;
        if (marker === 9)
          return true;
        break;
      case 1: {
        const size = 1 << nibble;
        if (size === 8) {
          const value = view.getBigInt64(at + 1);
          return Number.isSafeInteger(Number(value)) ? Number(value) : value;
        }
        if (size === 16)
          return view.getBigInt64(at + 9);
        return unsigned(at + 1, size);
      }
      case 2:
        return nibble === 2 ? view.getFloat32(at + 1) : view.getFloat64(at + 1);
      case 3:
        return new Date(appleEpoch + view.getFloat64(at + 1) * 1e3);
      case 4: {
        const [length, start] = lengthAt(at);
        return new Uint8Array(bytes.subarray(start, start + length));
      }
      case 5: {
        const [length, start] = lengthAt(at);
        return new TextDecoder("latin1").decode(bytes.subarray(start, start + length));
      }
      case 6: {
        const [length, start] = lengthAt(at);
        let text = "";
        for (let index = 0; index < length; index++)
          text += String.fromCharCode(view.getUint16(start + index * 2));
        return text;
      }
      case 8:
        return new PlistUid(unsigned(at + 1, nibble + 1));
      case 10:
      case 12: {
        const [length, start] = lengthAt(at);
        return Array.from({ length }, (_, index) => object(unsigned(start + index * referenceSize, referenceSize)));
      }
      case 13: {
        const [length, start] = lengthAt(at);
        const entries = {};
        for (let index = 0; index < length; index++) {
          const key = object(unsigned(start + index * referenceSize, referenceSize));
          if (typeof key !== "string")
            throw new TypeError("Property list dictionary key is not a string");
          entries[key] = object(unsigned(start + (length + index) * referenceSize, referenceSize));
        }
        return entries;
      }
    }
    throw new TypeError(`Unsupported property list marker 0x${marker.toString(16)}`);
  };
  return object(top);
}
function unarchive(archive) {
  if (!isDictionary(archive) || archive.$archiver !== "NSKeyedArchiver" || !Array.isArray(archive.$objects) || !isDictionary(archive.$top))
    throw new TypeError("Not an NSKeyedArchiver archive");
  const objects = archive.$objects;
  const resolving = /* @__PURE__ */ new Set();
  const resolve = (value) => {
    if (value instanceof PlistUid) {
      if (resolving.has(value.value))
        return { $ref: value.value };
      resolving.add(value.value);
      try {
        const target = objects[value.value];
        return target === "$null" || target === void 0 ? null : resolve(target);
      } finally {
        resolving.delete(value.value);
      }
    }
    if (Array.isArray(value))
      return value.map(resolve);
    if (!isDictionary(value))
      return value;
    const className = isUid(value.$class) ? classNameOf(objects[value.$class.value]) : void 0;
    if (className === void 0)
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, resolve(field)]));
    return decodeClass(className, value, resolve);
  };
  const top = archive.$top;
  const { root } = top;
  return resolve(root === void 0 ? top : root);
}
function decodeClass(className, value, resolve) {
  switch (className) {
    case "NSDictionary":
    case "NSMutableDictionary": {
      const keys = asArray(value["NS.keys"]).map(resolve);
      const values = asArray(value["NS.objects"]).map(resolve);
      return Object.fromEntries(keys.map((key, index) => [String(key), values[index] ?? null]));
    }
    case "NSArray":
    case "NSMutableArray":
    case "NSSet":
    case "NSMutableSet":
    case "NSOrderedSet":
    case "NSMutableOrderedSet":
      return asArray(value["NS.objects"]).map(resolve);
    case "NSString":
    case "NSMutableString":
      return resolve(value["NS.string"] ?? null);
    case "NSData":
    case "NSMutableData":
      return resolve(value["NS.data"] ?? null);
    case "NSDate":
      return new Date(appleEpoch + Number(value["NS.time"]) * 1e3);
    case "NSURL": {
      const relative = String(resolve(value["NS.relative"] ?? null));
      const base = resolve(value["NS.base"] ?? null);
      return typeof base === "string" ? new URL(relative, base).href : relative;
    }
    case "NSUUID": {
      const bytes = value["NS.uuidbytes"];
      if (!(bytes instanceof Uint8Array))
        throw new TypeError("NSUUID without bytes");
      const hex = Buffer.from(bytes).toString("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase();
    }
  }
  const fields = { $class: className };
  for (const [key, field] of Object.entries(value))
    if (key !== "$class")
      fields[key] = resolve(field);
  return fields;
}
function plistJSON(value) {
  return JSON.stringify(value, (_, field) => field instanceof Uint8Array ? Buffer.from(field).toString("base64") : typeof field === "bigint" ? field.toString() : field instanceof PlistUid ? { $uid: field.value } : field);
}
function decodeArchive(bytes) {
  const value = parseBinaryPlist(bytes);
  return isDictionary(value) && value.$archiver === "NSKeyedArchiver" ? unarchive(value) : value;
}
function isDictionary(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof Date) && !(value instanceof PlistUid);
}
function isUid(value) {
  return value instanceof PlistUid;
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function classNameOf(value) {
  return isDictionary(value) && typeof value.$classname === "string" ? value.$classname : void 0;
}

export {
  isBinaryPlist,
  parseBinaryPlist,
  plistJSON,
  decodeArchive,
  isDictionary
};
