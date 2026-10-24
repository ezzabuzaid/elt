import type { Vision } from '../vision.ts';
import { DocumentFormat } from './document-format.ts';
import type { FileHead } from './file-head.ts';

const heifBrands = ['heic', 'heix', 'hevc', 'mif1', 'msf1', 'avif'];

// The sizes that open a bitmap's info header, BITMAPCOREHEADER to
// BITMAPV5HEADER.
const bitmapHeaderSizes = [12, 40, 52, 56, 64, 108, 124];

export class ImageFormat extends DocumentFormat {
  readonly identity = 'image-v1';
  protected override readonly extensions = [
    'jpg',
    'jpeg',
    'png',
    'gif',
    'heic',
    'heif',
    'tif',
    'tiff',
    'bmp',
    'ico',
    'webp',
  ];

  protected override hasSignature(head: FileHead): boolean {
    const { ascii } = head;
    return (
      head.startsWith(0xff, 0xd8, 0xff) ||
      head.startsWith(0x89, 0x50, 0x4e, 0x47) ||
      ascii.startsWith('GIF87a') ||
      ascii.startsWith('GIF89a') ||
      ascii.startsWith('II*\0') ||
      ascii.startsWith('MM\0*') ||
      head.startsWith(0x00, 0x00, 0x01, 0x00) ||
      (ascii.startsWith('BM') &&
        ascii.slice(6, 10) === '\0\0\0\0' &&
        bitmapHeaderSizes.includes(ascii.charCodeAt(14)) &&
        ascii[15] === '\0') ||
      (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') ||
      (ascii.slice(4, 8) === 'ftyp' && heifBrands.includes(ascii.slice(8, 12)))
    );
  }

  readonly #vision: Vision;

  constructor(vision: Vision) {
    super();
    this.#vision = vision;
  }

  override text(path: string, signal?: AbortSignal): Promise<string | null> {
    return this.#vision.read(path, signal);
  }
}
