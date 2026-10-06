import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// packages/sources/apple/macos/dist/eventkit-fields.js
var text = { type: "string" };
var id = { ...text, minLength: 1 };
var nullableText = { type: ["string", "null"] };
var integer = { type: "integer" };
var ordinal = { ...integer, minimum: 0 };
var boolean = { type: "boolean" };
var number = { type: "number" };
var timestamp = { ...text, format: "date-time" };
var nullableTimestamp = { ...nullableText, format: "date-time" };
var nullableDate = { ...nullableText, format: "date" };
var location = {
  locationTitle: nullableText,
  latitude: { type: ["number", "null"], minimum: -90, maximum: 90 },
  longitude: { type: ["number", "null"], minimum: -180, maximum: 180 },
  radius: { type: ["number", "null"], minimum: 0 }
};
var eventKitFields = {
  text,
  id,
  nullableText,
  integer,
  ordinal,
  boolean,
  number,
  timestamp,
  nullableTimestamp,
  nullableDate,
  location
};

export {
  eventKitFields
};
