import type { RecordDraft } from '@workspace/elt';
import type { Pass } from '@workspace/sdk-apple-wallet';

import { AppleWalletStream, walletFields } from '../apple-wallet-stream.ts';

const { id, text, nullableText } = walletFields;

const properties = {
  passId: { ...id, description: 'The pass it is in; refers to passes.id.' },
  path: {
    ...id,
    description:
      'Its path in the pass bundle, such as strip@2x.png or en.lproj/logo.png.',
  },
  name: {
    ...id,
    description:
      'The image it is, its file name without scale and extension: icon, logo, strip, thumbnail, background, footer, or another the issuer added.',
  },
  scale: {
    type: 'integer',
    minimum: 1,
    description:
      'The screen scale it is drawn for: 1, or 2 and 3 for @2x and @3x files.',
  },
  language: {
    ...nullableText,
    description:
      'The language whose .lproj folder holds it; NULL for an image every language shows.',
  },
  sha1: {
    ...text,
    description:
      'The SHA-1 the bundle’s signed manifest.json gives the file; it changes with the image.',
  },
  file: {
    ...id,
    description:
      'Where the image is on this Mac, in the bundle Wallet keeps; the image file is exported from it.',
  },
} as const;

export class PassImagesStream extends AppleWalletStream<typeof properties> {
  readonly name = 'passImages';
  readonly primaryKey = ['passId', 'path'];
  readonly supportsFileTransfer = true;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per image in a pass’s bundle, with the image as its file: the logo and icon, and a strip, thumbnail or background that may show the event or the holder. Primary key passId, path.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected records(pass: Pass): RecordDraft<typeof properties>[] {
    return pass.images.map((image) => ({ passId: pass.id, ...image }));
  }

  // The image in the bundle Wallet keeps, not a copy: it stays until the pass
  // changes, and readers only read it.
  override file({ file }: Record<string, unknown>): string | null {
    return typeof file === 'string' ? file : null;
  }
}
