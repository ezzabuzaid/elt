import type { Image } from '@workspace/sdk-instagram-web';

export const fields = {
  profileId: {
    type: 'string',
    minLength: 1,
    description:
      'The Instagram user id of the profile the record was read from, as the profiles stream lists it.',
  },
  id: { type: 'string', minLength: 1 },
  text: { type: 'string' },
  nullableText: { type: ['string', 'null'] },
  count: { type: 'integer', minimum: 0 },
  flag: { type: 'boolean' },
  instant: { type: 'string', format: 'date-time' },
  textList: { type: 'array', items: { type: 'string' } },
  kind: {
    type: 'string',
    enum: ['photo', 'video', 'carousel'],
  },
} as const;

// An instant from the seconds since the epoch Instagram sends.
export function instant(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

const kinds = new Map([
  [1, 'photo'],
  [2, 'video'],
  [8, 'carousel'],
]);

// What Instagram's media_type code names.
export function kindOf(mediaType: number): string {
  const kind = kinds.get(mediaType);
  if (kind === undefined)
    throw new TypeError(`Instagram media type ${mediaType} is not known`);
  return kind;
}

// The largest rendition Instagram offers: the original upload, which reads
// best as text. A video's renditions are its cover frame.
export function largest(candidates: readonly Image[]): Image {
  const [first, ...rest] = candidates;
  if (first === undefined)
    throw new TypeError('Instagram listed media without an image');
  return rest.reduce(
    (best, image) =>
      image.width * image.height > best.width * best.height ? image : best,
    first,
  );
}

export function postUrl(code: string): string {
  return `https://www.instagram.com/p/${code}/`;
}

export function reelUrl(code: string): string {
  return `https://www.instagram.com/reel/${code}/`;
}
