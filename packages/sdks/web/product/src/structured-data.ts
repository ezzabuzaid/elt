import { decodeHTML } from 'entities';
import { Handler, type Result } from 'htmlmetaparser';
import { Parser } from 'htmlparser2';
import { JSONRepairError, jsonrepair } from 'jsonrepair';

/** A schema.org object as JSON-LD gives it: its properties by name. */
export type Thing = { readonly [property: string]: unknown };

/** The schema.org objects of a page: each syntax's top-level objects, in the page's order. */
export type StructuredData = {
  /** The canonical URL that the page declares in its head; null when it declares none. */
  readonly canonical: string | null;
  readonly jsonld: readonly Thing[];
  readonly microdata: readonly Thing[];
  /** Each JSON-LD object that has an @id and other properties, by its @id. */
  readonly ids: ReadonlyMap<string, Thing>;
};

export function isThing(value: unknown): value is Thing {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first value of a property: JSON-LD gives one value or an array of them. */
export function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

// Where the reader is in the page: outside a JSON-LD script, or inside one
// with the text that it has so far.
type Place = {
  opened(name: string, attributes: { [key: string]: string }): Place;
  read(value: string): Place;
  closed(name: string | undefined, blocks: string[]): Place;
};

const outside: Place = {
  opened: (name, attributes) =>
    name === 'script' &&
    attributes.type?.trim().toLowerCase().startsWith('application/ld+json')
      ? inside('')
      : outside,
  read: () => outside,
  closed: () => outside,
};

function inside(text: string): Place {
  return {
    opened: () => inside(text),
    read: (value) => inside(text + value),
    closed: (name, blocks) => {
      if (name !== 'script') return inside(text);
      blocks.push(text);
      return outside;
    },
  };
}

// htmlmetaparser drops a JSON-LD block that JSON.parse refuses, so the reader
// keeps the text of each block and repairs it.
class Reader extends Handler {
  readonly blocks: string[] = [];
  #place: Place = outside;

  override onopentag(name: string, attributes: { [key: string]: string }) {
    this.#place = this.#place.opened(name, attributes);
    super.onopentag(name, attributes);
  }

  override ontext(value: string) {
    this.#place = this.#place.read(value);
    super.ontext(value);
  }

  override onclosetag(name?: string) {
    this.#place = this.#place.closed(name, this.blocks);
    super.onclosetag();
  }
}

export function structuredData(html: string, url: string): StructuredData {
  let result: Result | undefined;
  const reader = new Reader(
    (error, value) => {
      if (error) throw error;
      result = value;
    },
    { url },
  );
  const parser = new Parser(reader, { decodeEntities: true });
  parser.write(html);
  parser.end();
  const jsonld = reader.blocks.flatMap((text) => things(parse(text)));
  return {
    canonical: result?.html?.canonical ?? null,
    jsonld,
    microdata: (result?.microdata ?? []).map(unwrap).filter(isThing),
    ids: identified(jsonld),
  };
}

// A block is read as written, then without its HTML comment or CDATA frame,
// then with its HTML entities decoded, and only then repaired, as extruct
// tries its fixes in turn: entities in valid JSON stay as written, because a
// script element's text is raw.
function parse(text: string): unknown {
  const unframed = text
    .replace(/^\s*(?:<!--|\/\*\s*<!\[CDATA\[\s*\*\/|<!\[CDATA\[)/, '')
    .replace(/(?:-->|\/\*\s*\]\]>\s*\*\/|\]\]>)\s*$/, '');
  const candidates = new Set([text, unframed, decodeHTML(unframed)]);
  // Every candidate is read as JSON before any is repaired: jsonrepair turns
  // escaped JSON into some object, not into the one that its entities hide.
  for (const read of [
    (value: string): unknown => JSON.parse(value),
    (value: string): unknown => JSON.parse(jsonrepair(value)),
  ])
    for (const candidate of candidates)
      try {
        return read(candidate);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof JSONRepairError))
          throw error;
      }
  return undefined;
}

// The objects of a block: an array is its items, and a @graph is its members.
function things(value: unknown): Thing[] {
  if (Array.isArray(value)) return value.flatMap(things);
  if (!isThing(value)) return [];
  return value['@graph'] === undefined ? [value] : things(value['@graph']);
}

function identified(roots: readonly Thing[]) {
  const ids = new Map<string, Thing>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (isThing(value)) {
      const id = value['@id'];
      if (
        typeof id === 'string' &&
        !ids.has(id) &&
        Object.keys(value).some((key) => key !== '@id')
      )
        ids.set(id, value);
      Object.values(value).forEach(visit);
    }
  };
  roots.forEach(visit);
  return ids;
}

// htmlmetaparser gives each microdata value as an array of { "@value",
// "@language" } or of items; one value is read as JSON-LD gives it.
function unwrap(value: unknown): unknown {
  if (Array.isArray(value)) {
    const values = value.map(unwrap);
    return values.length === 1 ? values[0] : values;
  }
  if (!isThing(value)) return value;
  if ('@value' in value) return value['@value'];
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '@context')
      .map(([key, item]) => [key, unwrap(item)]),
  );
}
