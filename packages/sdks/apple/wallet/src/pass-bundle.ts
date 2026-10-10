import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isDictionary, readPlist } from '@workspace/codec-plist';

import { PassBundleError } from './errors.ts';
import { passContent } from './pass-content.ts';
import { type PassJson, isPassObject, parsePassJson } from './pass-json.ts';
import type { PassAssets, PassContent, PassImage, PassString } from './pass.ts';

const stringsPath = /^(?<language>[^/]+)\.lproj\/pass\.strings$/;
const imagePath =
  /^(?:(?<language>[^/]+)\.lproj\/)?(?<name>.+?)(?:@(?<scale>\d+)x)?\.png$/i;

// A pass bundle as Wallet keeps it, a folder holding what the issuer signed:
// pass.json, its images and localizations, and manifest.json, which lists
// every other file with its SHA-1.
export async function readPassBundle(
  id: string,
  directory: string,
): Promise<PassContent & PassAssets> {
  try {
    const manifest = await json(join(directory, 'manifest.json'));
    if (!isPassObject(manifest))
      throw new TypeError('manifest.json is not an object');
    const content = passContent(await json(join(directory, 'pass.json')));
    const strings: PassString[] = [];
    const images: PassImage[] = [];
    let personalization: PassJson | null = null;
    for (const [path, sha1] of Object.entries(manifest)) {
      if (typeof sha1 !== 'string')
        throw new TypeError(`manifest.json gives ${path} no SHA-1`);
      const file = join(directory, path);
      const localized = stringsPath.exec(path)?.groups;
      const image = imagePath.exec(path)?.groups;
      if (localized?.language !== undefined)
        strings.push(...(await passStrings(file, localized.language)));
      else if (image?.name !== undefined)
        images.push({
          path,
          file,
          name: image.name,
          scale: Number(image.scale ?? 1),
          language: image.language ?? null,
          sha1,
        });
      else if (path === 'personalization.json')
        personalization = await json(file);
    }
    return { ...content, strings, images, personalization };
  } catch (cause) {
    throw new PassBundleError(id, directory, cause);
  }
}

async function json(path: string): Promise<PassJson> {
  return parsePassJson(await readFile(path, 'utf8'));
}

// pass.strings is a strings file, an old-style property list of text, in
// UTF-8 or UTF-16; plutil reads either.
async function passStrings(
  file: string,
  language: string,
): Promise<PassString[]> {
  const table = await readPlist(file);
  if (!isDictionary(table))
    throw new TypeError(`${language}.lproj/pass.strings is not a table`);
  return Object.entries(table).map(([key, text]) => {
    if (typeof text !== 'string')
      throw new TypeError(
        `${language}.lproj/pass.strings gives ${key} no text`,
      );
    return { language, key, text };
  });
}
