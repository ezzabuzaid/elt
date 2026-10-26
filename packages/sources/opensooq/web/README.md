# OpenSooq listings

`listings` is a `WebStream` for `WebSource` from `@workspace/source-web-pages`. It reads the listings of the OpenSooq category pages that you give as inputs, such as `https://jo.opensooq.com/en/cars/motorcycles`.

```ts
import { listings } from '@workspace/source-opensooq-web/listings';
import { WebSource } from '@workspace/source-web-pages/web-source';

const source = new WebSource({
  stream: listings,
  inputs: ['https://jo.opensooq.com/en/cars/motorcycles'],
  pollIntervalMs: 3_600_000,
});
```

The stream `opensooq_listings` follows each category's `rel="next"` pagination with `ArchiveReader` and extracts the pages whose path matches `/:lang/search/*`. It does not use `ListingReader`, because OpenSooq's `robots.txt` lists the sitemaps of 20 country sites.

`OpenSooqExtractor` reads the schema.org JSON-LD of a listing page. A listing page also embeds Organization, BreadcrumbList and FAQPage objects; the listing object is the one whose `sku` is the number in the page URL. One zod schema validates it. A page without that object gives no record. A listing object that does not match the schema is a failure of that page, and the page is tried again on the next run.

| Column         | From the listing object                          |
| -------------- | ------------------------------------------------ |
| `id`           | `sku`, as text; the stream's key with `inputUrl` |
| `title`        | `name`                                           |
| `description`  | `description`                                    |
| `url`          | the final URL of the listing page                |
| `type`         | `@type`, such as `Motorcycle`                    |
| `price`        | `offers.price` as a number, or null              |
| `currency`     | `offers.priceCurrency`, or null                  |
| `location`     | `image.contentLocation` as given, or null        |
| `imageUrls`    | `[image.contentUrl]`                             |
| `condition`    | `itemCondition`, or null                         |
| `availability` | `offers.availability`, or null                   |
| `publishedAt`  | `image.datePublished` as given, or null          |

The page fingerprint is the hash of the validated listing object and the page URL. Changes elsewhere in the page, such as ads or timestamps, do not cause an extraction.

OpenSooq's terms do not permit automated retrieval, and a web application firewall blocks heavy traffic. The tests use a local HTTP server with copies of the real JSON-LD; they make no request to OpenSooq.
