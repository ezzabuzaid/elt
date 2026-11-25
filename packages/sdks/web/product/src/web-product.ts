import {
  type Offered,
  type Price,
  bareName,
  cheapest,
  decimal,
  offered,
  text,
} from './price.ts';
import {
  type StructuredData,
  type Thing,
  first,
  isThing,
  structuredData,
} from './structured-data.ts';

export type { Price } from './price.ts';

/** A barcode number of the product, by the schema.org property that gives it. */
export type Gtin = {
  readonly type: 'gtin' | 'gtin8' | 'gtin12' | 'gtin13' | 'gtin14';
  readonly value: string;
};

/** The ratings of a product: their average and how many there are. */
export type Rating = {
  readonly value: string;
  readonly count: number | null;
};

/** One product of a ProductGroup, such as one size or one colour. */
export type ProductVariant = {
  readonly name: string;
  readonly url: string;
  readonly sku: string | null;
  readonly mpn: string | null;
  readonly gtins: readonly Gtin[];
  readonly images: readonly string[];
  readonly color: string | null;
  readonly size: string | null;
  readonly price: Price | null;
  readonly availability: string | null;
};

/** The product that a shop's page declares in its schema.org data. */
export type Product = {
  readonly name: string;
  /** The product's own URL as the page declares it, resolved; else the page's URL. */
  readonly url: string;
  /** The canonical URL that the page declares in its head; null when it declares none. */
  readonly canonicalUrl: string | null;
  readonly description: string | null;
  readonly brand: string | null;
  readonly category: string | null;
  readonly sku: string | null;
  readonly mpn: string | null;
  /** schema.org model, such as a maker's part number. */
  readonly model: string | null;
  readonly productId: string | null;
  readonly gtins: readonly Gtin[];
  readonly images: readonly string[];
  readonly color: string | null;
  readonly size: string | null;
  readonly rating: Rating | null;
  readonly price: Price | null;
  /** The bare schema.org name, such as InStock; null when the page gives none. */
  readonly availability: string | null;
  /** The bare schema.org name, such as NewCondition; null when the page gives none. */
  readonly itemCondition: string | null;
  /** The variants of a ProductGroup; empty for a Product. */
  readonly variants: readonly ProductVariant[];
  readonly syntax: 'json-ld' | 'microdata';
  /** The product's object as the page declares it, JSON-LD-shaped, for what the record has no field for. */
  readonly data: Thing;
};

// schema.org's Product and its more specific types.
const productTypes = new Set([
  'Product',
  'DietarySupplement',
  'Drug',
  'IndividualProduct',
  'ProductCollection',
  'ProductGroup',
  'ProductModel',
  'SomeProducts',
  'Vehicle',
  'BusOrCoach',
  'Car',
  'Motorcycle',
  'MotorizedBicycle',
]);

const gtinTypes = ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14'] as const;

/** Reads the product that a shop's page declares in its schema.org data. */
export class WebProduct {
  /**
   * The page's product, or null when the page declares none, or several of
   * which none is the page's own.
   * @param html The page's text, decoded by its charset.
   * @param url The final URL of the response.
   * @param at When the page was downloaded, in milliseconds since the epoch:
   *   a price specification holds only between its validFrom and validThrough.
   */
  static read(html: string, url: string, at: number): Product | null {
    const data = structuredData(html, url);
    const pages = [url, ...(data.canonical === null ? [] : [data.canonical])];
    // Each syntax on its own, so one product written in both is not two.
    for (const [syntax, things] of [
      ['json-ld', data.jsonld],
      ['microdata', data.microdata],
    ] as const) {
      const thing = pageProduct(things, pages);
      if (thing !== undefined)
        return thing === null ? null : product(thing, syntax, data, url, at);
    }
    return null;
  }
}

// The page's product: the product whose url or @id is the page, else the only
// top-level one (ADR 0002); null when several remain; undefined when the
// syntax gives no product at all.
function pageProduct(things: readonly Thing[], pages: readonly string[]) {
  const variantIds = new Set(
    things.flatMap((thing) =>
      [thing.hasVariant]
        .flat()
        .flatMap((variant) =>
          isThing(variant) && typeof variant['@id'] === 'string'
            ? [variant['@id']]
            : [],
        ),
    ),
  );
  const candidates = things.filter(
    (thing) =>
      isProduct(thing) &&
      !('isVariantOf' in thing) &&
      !(typeof thing['@id'] === 'string' && variantIds.has(thing['@id'])),
  );
  if (candidates.length === 0) return undefined;
  const own = candidates.find((thing) =>
    pages.some(
      (page) =>
        sameUrl(text(thing.url), page) ||
        sameUrl(typeof thing['@id'] === 'string' ? thing['@id'] : null, page),
    ),
  );
  return own ?? (candidates.length === 1 ? candidates[0] : null);
}

function isProduct(thing: Thing) {
  return [thing['@type']]
    .flat()
    .some(
      (type) =>
        typeof type === 'string' && productTypes.has(bareName(type) ?? ''),
    );
}

// Two URLs of one page: the scheme, the fragment, a trailing slash and the
// case of percent-escapes do not matter, as leaders.jo writes its @id with
// Arabic letters and its page URL with escapes.
function sameUrl(value: string | null, page: string) {
  if (value === null) return false;
  const left = URL.parse(value, page);
  const right = URL.parse(page);
  return left !== null && right !== null && key(left) === key(right);
}

function key(url: URL) {
  const path = `${url.pathname.replace(/\/$/, '')}${url.search}`;
  try {
    return `${url.host}${decodeURIComponent(path)}`;
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return `${url.host}${path}`;
  }
}

function product(
  thing: Thing,
  syntax: Product['syntax'],
  data: StructuredData,
  page: string,
  at: number,
): Product | null {
  const resolve = resolver(data);
  const name = text(thing.name);
  if (name === null) return null;
  const variants = [thing.hasVariant]
    .flat()
    .map(resolve)
    .filter(isThing)
    .map((variant) => variantOf(variant, name, resolve, page, at));
  const chosen = variants.length > 0 ? groupOffer(variants, page) : null;
  const own = offered(thing, resolve, at);
  return {
    name,
    url: link(text(thing.url), page) ?? page,
    canonicalUrl: data.canonical === null ? null : link(data.canonical, page),
    description: text(thing.description),
    brand: named(resolve(first(thing.brand))),
    category: named(resolve(first(thing.category))),
    sku: text(thing.sku),
    mpn: text(thing.mpn),
    model: named(resolve(first(thing.model))),
    productId: text(thing.productID),
    gtins: gtinsOf(thing),
    images: imagesOf(thing, resolve, page),
    color: named(resolve(first(thing.color))),
    size: named(resolve(first(thing.size))),
    rating: ratingOf(resolve(first(thing.aggregateRating))),
    price: chosen?.price ?? own.price,
    availability: chosen?.availability ?? own.availability,
    itemCondition: own.itemCondition ?? bareName(text(thing.itemCondition)),
    variants,
    syntax,
    data: thing,
  };
}

function variantOf(
  variant: Thing,
  group: string,
  resolve: (value: unknown) => unknown,
  page: string,
  at: number,
): ProductVariant {
  const { price, availability }: Offered = offered(variant, resolve, at);
  return {
    name: text(variant.name) ?? group,
    url: link(text(variant.url), page) ?? page,
    sku: text(variant.sku),
    mpn: text(variant.mpn),
    gtins: gtinsOf(variant),
    images: imagesOf(variant, resolve, page),
    color: named(resolve(first(variant.color))),
    size: named(resolve(first(variant.size))),
    price,
    availability,
  };
}

// A ProductGroup's price is its variant's: the variant that the page's URL
// names, as Shopify's ?variant=, else the cheapest (ADR 0003).
function groupOffer(variants: readonly ProductVariant[], page: string) {
  const wanted = new URL(page).searchParams.get('variant');
  const chosen =
    wanted === null
      ? undefined
      : variants.find(
          (variant) =>
            variant.sku === wanted ||
            URL.parse(variant.url)?.searchParams.get('variant') === wanted,
        );
  if (chosen?.price) return chosen;
  const priced = variants.filter((variant) => variant.price !== null);
  const currency = priced[0]?.price?.currency;
  const sameCurrency = priced.filter(
    (variant) => variant.price?.currency === currency,
  );
  return sameCurrency.length > 0 ? cheapest(sameCurrency) : null;
}

// A JSON-LD object that only names an @id is the object of that @id.
function resolver(data: StructuredData) {
  return (value: unknown): unknown => {
    if (!isThing(value)) return value;
    const id = value['@id'];
    return typeof id === 'string' && Object.keys(value).length === 1
      ? (data.ids.get(id) ?? value)
      : value;
  };
}

// The text of a value, or the name of the object that it is, such as a Brand.
function named(value: unknown) {
  return text(value) ?? (isThing(value) ? text(value.name) : null);
}

function link(value: string | null, page: string) {
  if (value === null) return null;
  const url = URL.parse(value, page);
  return url !== null && (url.protocol === 'https:' || url.protocol === 'http:')
    ? url.href
    : null;
}

// Barcode numbers as digits; Google does not read the URL form of a GTIN.
function gtinsOf(thing: Thing): Gtin[] {
  return gtinTypes.flatMap((type) =>
    [thing[type]].flat().flatMap((value) => {
      const digits = text(value);
      return digits !== null && /^\d+$/.test(digits)
        ? [{ type, value: digits }]
        : [];
    }),
  );
}

function imagesOf(
  thing: Thing,
  resolve: (value: unknown) => unknown,
  page: string,
) {
  return [
    ...new Set(
      [thing.image]
        .flat()
        .map(resolve)
        .flatMap((image) => {
          const url = link(
            isThing(image)
              ? (text(image.contentUrl) ?? text(image.url))
              : text(image),
            page,
          );
          return url === null ? [] : [url];
        }),
    ),
  ];
}

function ratingOf(value: unknown): Rating | null {
  if (!isThing(value)) return null;
  const average = decimal(value.ratingValue);
  if (average === null) return null;
  const count = Number(text(value.reviewCount) ?? text(value.ratingCount));
  return { value: average, count: Number.isInteger(count) ? count : null };
}
