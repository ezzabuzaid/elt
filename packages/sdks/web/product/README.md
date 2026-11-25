# Web product

The product that a shop's page declares in its schema.org data, as one record: its name, identifiers, images, price and variants. The SDK reads JSON-LD and microdata. It knows no elt type, as the crawler and `@eltjs/sdk-web-article` know none; `ProductExtractor` of `@eltjs/source-web-pages` gives its record to a web stream.

On 2026-11-24, 18 of the 46 Jordanian shop hosts with 20 or more product URLs in Common Crawl `CC-MAIN-2026-43` declared a schema.org `Product` on a product page: 16 in JSON-LD (WooCommerce, Shopify, OpenCart and custom Next.js shops) and 2 in microdata only (an Odoo shop and one other). One reader thus serves every shop platform, and a shop needs no wrapper of its own.

## Read a page

```ts
import { WebProduct } from '@eltjs/sdk-web-product';

const product = WebProduct.read(html, url, at);
// null when the page declares no product, or several that none of them is the page's own
```

`html` is the page's text, decoded by its charset. `url` is the final URL of the response; the SDK resolves relative URLs against it and finds the page's own product by it. `at` is when the page was downloaded, in milliseconds since the epoch, such as got's `response.timings.start`: a price specification holds only between its `validFrom` and `validThrough`, so the price of a page depends on its time, and the SDK reads no clock (zukhruf ADR 0004).

## The product

```ts
type Product = {
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
  /** schema.org model, such as a maker's part number: OpenCart's City Center gives MSI's 9S7-265343-214 there. */
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

type Gtin = {
  readonly type: 'gtin' | 'gtin8' | 'gtin12' | 'gtin13' | 'gtin14';
  readonly value: string;
};

type Rating = { readonly value: string; readonly count: number | null };

type Price = {
  /** The price to pay, as a decimal string with '.' as its point, such as "12.000" for JOD. */
  readonly amount: string;
  /** The ISO 4217 code, such as JOD, as the shop gives it; null when it gives none. */
  readonly currency: string | null;
  /** The price before a sale, only when it is higher than amount. */
  readonly regular: string | null;
  /** The lowest and highest price of an AggregateOffer; amount is the lowest. */
  readonly range: { readonly low: string; readonly high: string } | null;
};

type ProductVariant = Pick<
  Product,
  | 'name'
  | 'url'
  | 'sku'
  | 'mpn'
  | 'gtins'
  | 'images'
  | 'color'
  | 'size'
  | 'price'
  | 'availability'
>;
```

The typed fields are those that a consumer decides with: the identifiers, the price, the availability, the attributes that tell variants apart, the rating and the category. `data` keeps the product's object as the page declares it, as Airbyte keeps `_airbyte_data`, so a value that the record has no field for, such as `priceValidUntil` or `additionalProperty`, is not lost.

| Call                             | What happens underneath                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebProduct.read(html, url, at)` | htmlparser2 parses the HTML once, and htmlmetaparser gives its JSON-LD blocks and its microdata items. A block that `JSON.parse` refuses is repaired with jsonrepair. Each block's `@graph` and arrays are flattened, and `@id` references are resolved. Microdata values lose their `@value` and `@language` wrappers. The page's product is chosen ([ADR 0002](./docs/adr/0002-the-page-s-product-is-the-one-whose-url-is-the-page-else-the-only-one.md)), and its price ([ADR 0003](./docs/adr/0003-the-price-is-google-s-active-price-and-a-struck-price-is-the-regular-price.md)). |

## How the price is chosen

The SDK reads a price as Google's merchant listings read it ([ADR 0003](./docs/adr/0003-the-price-is-google-s-active-price-and-a-struck-price-is-the-regular-price.md)):

1. `offers.price` wins over `offers.priceSpecification`, as Google uses `offers.price` when both give an active price.
2. Else the price specification with no `priceType` (or `SalePrice`, which WooCommerce gives a variable product on sale) and no `validForMemberTier` is the price, when `at` is inside its `validFrom` and `validThrough`.
3. A specification with `priceType` `StrikethroughPrice`, `ListPrice`, `RegularPrice`, `MSRP` or `SRP` is the regular price, kept only when it is higher than the price, as Zyte's `regularPrice`. WooCommerce marks its regular price `ListPrice`; WPSSO marks it `StrikethroughPrice`.
4. An `AggregateOffer` gives its `lowPrice` as the amount and `lowPrice`–`highPrice` as the range, as Diffbot's `offerPrice` and `priceRange`.
5. Of several offers, the lowest that is in stock wins; prices in two currencies are never compared, and the currency of the first offer wins.
6. A ProductGroup's price is the price of the variant that the page's URL names (Shopify's `?variant=`), else of its cheapest variant.

A price is a decimal string with `.` as its point, as schema.org asks: `12.000` is twelve JOD. A comma is a thousands separator, a currency symbol or code around the number is not part of it, and Arabic-Indic digits are read as digits. A price of zero is no price, as Google shows only a price greater than zero: a shop writes it for "price on request". A currency is kept as the shop gives it, also USD.

## When something fails

`read` throws no error for a page's data: a page whose data names no product, or a block that no repair can read, gives null or loses that block, as a search engine skips data it cannot read. A product without a name is no product, as Google requires `name`.

## What the SDK does not do

- It runs no script: a page that writes its data with JavaScript after it loads gives none.
- It reads no RDFa and no Open Graph product tags: none of the 46 shops needed them. htmlmetaparser gives both, so a later version can.
- It converts no currency, and it does not tell two shops' copies of one product apart; that is product matching, a job of the host.

## The same concepts in other systems

| Concept                 | Here                                        | Google                        | Zyte                                | Diffbot                     |
| ----------------------- | ------------------------------------------- | ----------------------------- | ----------------------------------- | --------------------------- |
| The price to pay        | `price.amount`                              | the active price              | `price`                             | `offerPrice`                |
| The price before a sale | `price.regular`                             | `StrikethroughPrice`          | `regularPrice`                      | `regularPrice`              |
| Several prices          | `price.range`                               | `AggregateOffer`              | —                                   | `priceRange`                |
| Variants                | `variants`                                  | `ProductGroup` + `hasVariant` | `variants`                          | —                           |
| Identifiers             | `sku`, `mpn`, `model`, `gtins`, `productId` | `sku`, `mpn`, `gtin*`         | `sku`, `mpn`, `gtin[]`, `productId` | `sku`, `mpn`, `gtin`, `upc` |

## Why not an npm package alone

| Package                                                        | What it misses                                                                                                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `htmlmetaparser` 2.1.3                                         | Used: it reads JSON-LD, microdata and RDFa on htmlparser2 with no DOM, resolves URLs and reads `content` on every element. It neither repairs JSON-LD nor flattens `@graph`, and it knows no product. |
| `@marbec/web-auto-extractor` 2.2.1                             | Maintained and has no dependency, but it groups items by type, so it loses their order and nesting, and it does not resolve URLs.                                                                     |
| `metascraper` 5.58.7                                           | Reads JSON-LD as a property lookup only: no microdata objects.                                                                                                                                        |
| `microdata-node` 2.0.0, `microdata-rdf-streaming-parser` 3.1.0 | Microdata only, or RDF quads that the caller turns back into objects.                                                                                                                                 |
| `schema-dts`                                                   | Types only: it reads nothing.                                                                                                                                                                         |

No npm package chooses a page's product and its price as Google does (searched: "schema.org product extract", "structured data product price", "jsonld microdata extract").

## Package ownership

| Concern                                                 | Owner                                           |
| ------------------------------------------------------- | ----------------------------------------------- |
| Reading JSON-LD and microdata                           | htmlmetaparser, htmlparser2, jsonrepair         |
| The page's product, its identifiers, price and variants | This SDK                                        |
| A web stream's records, fingerprint and provenance      | `ProductExtractor` in `@eltjs/source-web-pages` |
| Which shops to crawl, and product matching              | The host                                        |

## Documentation

- [CONTEXT.md](./CONTEXT.md): the words of this package.
- [ADR 0001](./docs/adr/0001-htmlmetaparser-reads-the-syntaxes-and-the-sdk-reads-the-product.md): htmlmetaparser reads the syntaxes, and the SDK reads the product.
- [ADR 0002](./docs/adr/0002-the-page-s-product-is-the-one-whose-url-is-the-page-else-the-only-one.md): the page's product is the one whose URL is the page, else the only one.
- [ADR 0003](./docs/adr/0003-the-price-is-google-s-active-price-and-a-struck-price-is-the-regular-price.md): the price is Google's active price, and a struck price is the regular price.
