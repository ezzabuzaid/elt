import type { RecordDraft } from '@workspace/elt';
import type { Pass } from '@workspace/sdk-apple-wallet';

import { AppleWalletStream, walletFields } from '../apple-wallet-stream.ts';

const { id, text, nullableText, ordinal } = walletFields;

const properties = {
  passId: { ...id, description: 'The pass it is on; refers to passes.id.' },
  position: {
    ...ordinal,
    description:
      'Its place among the pass’s barcodes, from 0; Wallet shows the first one the device can draw.',
  },
  format: {
    ...text,
    description:
      'The kind of barcode (format), such as PKBarcodeFormatQR, PKBarcodeFormatPDF417, PKBarcodeFormatAztec or PKBarcodeFormatCode128.',
  },
  message: {
    ...text,
    description:
      'What the barcode encodes (message), what a scanner at a gate or a till reads: a boarding pass’s booking data, a ticket’s or card’s number.',
  },
  messageEncoding: {
    ...text,
    description:
      'The text encoding the barcode carries message in (messageEncoding), such as iso-8859-1.',
  },
  altText: {
    ...nullableText,
    description:
      'The text Wallet shows under the barcode (altText); NULL when it shows none.',
  },
} as const;

export class PassBarcodesStream extends AppleWalletStream<typeof properties> {
  readonly name = 'passBarcodes';
  readonly primaryKey = ['passId', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per barcode a pass offers, from its barcodes list, or its single barcode when a pass made before iOS 9 has no list. Primary key passId, position.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected records(pass: Pass): RecordDraft<typeof properties>[] {
    return pass.barcodes.map((barcode) => ({ passId: pass.id, ...barcode }));
  }
}
