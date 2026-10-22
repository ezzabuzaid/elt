import { resolve } from 'node:path';

import osa from '../osa.ts';
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

  // Vision's accurate text recognition, one line per observation.
  override async text(path: string): Promise<string | null> {
    const content: unknown = JSON.parse(
      await osa.execute(`
        ObjC.import('Vision');
        ObjC.import('ImageIO');
        function recognize() {
        const path = ${JSON.stringify(resolve(path))};
        const image = $.CGImageSourceCreateWithURL($.NSURL.fileURLWithPath(path), null);
        const properties = ObjC.castRefToObject($.CGImageSourceCopyPropertiesAtIndex(image, 0, null));
        if (properties.isNil()) throw new Error('Cannot read image');
        // Vision crashes on 1px and 2px images (macOS 26.6.2 and 27.0).
        for (const key of [$.kCGImagePropertyPixelWidth, $.kCGImagePropertyPixelHeight])
          if (Number(ObjC.unwrap(properties.objectForKey(ObjC.castRefToObject(key)))) < 3) return null;
        const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(
          $.NSURL.fileURLWithPath(path), $()
        );
        const request = $.VNRecognizeTextRequest.alloc.init;
        request.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
        request.automaticallyDetectsLanguage = true;
        // Reading Vision's NSError through a JXA Ref crashes osascript (macOS
        // 27.0), so the failure carries no reason.
        if (!handler.performRequestsError($([request]), null))
          throw new Error('Cannot read image: Vision failed');
        const lines = [];
        const results = request.results;
        for (let index = 0; index < results.count; index++)
          lines.push(ObjC.unwrap(results.objectAtIndex(index).topCandidates(1).objectAtIndex(0).string));
        return lines.length > 0 ? lines.join('\\n') : null;
        }
        JSON.stringify(recognize());
      `),
    );
    if (content !== null && typeof content !== 'string')
      throw new TypeError('Vision returned unexpected content');
    return content;
  }
}
