import type { RecordDraft } from '@workspace/elt';
import { type Pass, passJsonText } from '@workspace/sdk-apple-wallet';

import { AppleWalletStream, walletFields } from '../apple-wallet-stream.ts';

const {
  id,
  text,
  nullableText,
  ordinal,
  boolean,
  nullableInteger,
  nullableTextList,
} = walletFields;

const properties = {
  passId: { ...id, description: 'The pass it is on; refers to passes.id.' },
  area: {
    ...id,
    description:
      'Where the pass shows it, the pass.json array it is in without "Fields": header, primary, secondary, auxiliary, back (behind the pass) or additionalInfo.',
  },
  position: {
    ...ordinal,
    description: 'Its place in its area, from 0, in pass.json’s order.',
  },
  key: {
    ...id,
    description:
      'The issuer’s name for the field (key), such as boarding-gate or seat.',
  },
  label: {
    ...nullableText,
    description:
      'The text above the value (label), such as GATE, or its localization key: passLocalizations holds each language’s text. NULL when the field shows none.',
  },
  value: {
    ...text,
    description:
      'What the field shows (value) as pass.json writes it: text or its localization key, a number’s digits, or a W3C date that dateStyle and timeStyle format.',
  },
  attributedValue: {
    ...nullableText,
    description:
      'The value with HTML links that Wallet shows behind the pass (attributedValue); NULL when the field has none.',
  },
  changeMessage: {
    ...nullableText,
    description:
      'The notification Wallet shows when an update changes the value (changeMessage), %@ standing for the new value; NULL when the change is silent.',
  },
  textAlignment: {
    ...nullableText,
    description:
      'How the field is aligned (textAlignment), such as PKTextAlignmentRight; NULL for Wallet’s default.',
  },
  dateStyle: {
    ...nullableText,
    description:
      'How Wallet shows the date in value (dateStyle), such as PKDateStyleShort; NULL when value is not shown as a date.',
  },
  timeStyle: {
    ...nullableText,
    description:
      'How Wallet shows the time in value (timeStyle); NULL when value is not shown as a time.',
  },
  ignoresTimeZone: {
    ...boolean,
    description:
      'Whether Wallet shows the date in the time zone it was written in rather than the device’s (ignoresTimeZone).',
  },
  isRelative: {
    ...boolean,
    description:
      'Whether Wallet shows the date relative to now, such as in 2 hours (isRelative).',
  },
  numberStyle: {
    ...nullableText,
    description:
      'How Wallet shows the number in value (numberStyle), such as PKNumberStylePercent; NULL when it shows none.',
  },
  currencyCode: {
    ...nullableText,
    description:
      'The ISO 4217 currency Wallet shows value in (currencyCode); NULL when value is no amount.',
  },
  dataDetectorTypes: {
    ...nullableTextList,
    description:
      'What Wallet turns into links in a value behind the pass (dataDetectorTypes), such as PKDataDetectorTypeLink; NULL for Wallet’s default.',
  },
  row: {
    ...nullableInteger,
    description:
      'For an auxiliary field of an event ticket, the row it is in (row), 0 or 1; NULL otherwise.',
  },
  semantics: {
    ...nullableText,
    description:
      'The field’s semantic tags (semantics) as JSON; NULL when it carries none.',
  },
} as const;

export class PassFieldsStream extends AppleWalletStream<typeof properties> {
  readonly name = 'passFields';
  readonly primaryKey = ['passId', 'area', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per field a pass shows, on its front or behind it: a flight’s gate and seat, a ticket’s date and location, a card’s balance. Primary key passId, area, position.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected records(pass: Pass): RecordDraft<typeof properties>[] {
    return pass.fields.map((field) => ({
      passId: pass.id,
      area: field.area,
      position: field.position,
      key: field.key,
      label: field.label,
      value: field.value,
      attributedValue: field.attributedValue,
      changeMessage: field.changeMessage,
      textAlignment: field.textAlignment,
      dateStyle: field.dateStyle,
      timeStyle: field.timeStyle,
      ignoresTimeZone: field.ignoresTimeZone,
      isRelative: field.isRelative,
      numberStyle: field.numberStyle,
      currencyCode: field.currencyCode,
      dataDetectorTypes: field.dataDetectorTypes,
      row: field.row,
      semantics:
        field.semantics === null ? null : passJsonText(field.semantics),
    }));
  }
}
