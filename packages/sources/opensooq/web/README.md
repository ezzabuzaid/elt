# OpenSooq listings

`listings` is a `WebStream` for `WebSource` from `@workspace/source-web-pages`. It reads the listings of the OpenSooq category pages that you give as inputs, such as `https://jo.opensooq.com/en/cars/motorcycles`.

```ts
import { listings } from '@workspace/source-opensooq-web/listings';
import { WebSource } from '@workspace/source-web-pages/web-source';

const source = new WebSource({
  stream: listings,
  inputs: ['https://jo.opensooq.com/en/cars/motorcycles'],
  cachePath: './web-http.sqlite',
  userAgent: 'ExampleReader/1.0 (+https://example.com/contact)',
});
```

The stream `opensooq_listings` reads each category with `PaginationReader`: it reads the category page and the pages that its `rel="next"` and `rel="prev"` links reach, and no other list. A category with few listings, which has no pagination, still gives its listings. It extracts the pages whose path matches `/:lang/search/*`; the listings a listing page links as related ads are not downloaded. The filters that a category or a listing page links, such as the year filter `/en/cars/motorcycles/2024` or the city, brand, model and year filter in a listing's breadcrumb, are not read, and neither is the category in the other language. It does not use `ListingReader`, because OpenSooq's `robots.txt` lists the sitemaps of 20 country sites. It does not use `ArchiveReader`, because OpenSooq has no year archives. A year filter, such as `/en/cars/motorcycles/2024`, ends in a year, but it is not an archive.

`OpenSooqExtractor` reads the schema.org JSON-LD of a listing page. A listing page also embeds Organization, BreadcrumbList and FAQPage objects; the listing object is the one whose `url` path is `/:lang/search/<id>` with the id of the page URL. The `@type` of the listing object is a schema.org type. On 2026-10-26, the live listings had five types: `Motorcycle`, `Product`, `Residence`, `Service` and `Vehicle`. One zod schema validates each of them, and it accepts any `@type`. A listing page without that object, or with an object that does not match the schema, is a failure of that page, and the page is tried again on the next run. A page that is not a listing page gives no record.

| Column         | From the listing object                                               |
| -------------- | --------------------------------------------------------------------- |
| `id`           | the id in the listing path, as text; the stream's key with `inputUrl` |
| `title`        | `name`                                                                |
| `description`  | `description`, or null (`Residence` has none)                         |
| `url`          | the final URL of the listing page                                     |
| `type`         | `@type`, such as `Motorcycle`                                         |
| `price`        | `offers.price` as a number                                            |
| `currency`     | `offers.priceCurrency`                                                |
| `location`     | `contentLocation` of the image, as given                              |
| `imageUrls`    | `[contentUrl]` of the image                                           |
| `condition`    | `itemCondition`, or null (only `Motorcycle` has one)                  |
| `availability` | `offers.availability`                                                 |
| `publishedAt`  | `datePublished` of the image as given, or null (`Product` has none)   |

The image is under `image`, or under `photo` for `Residence`.

The page fingerprint is the hash of the validated listing object and the page URL. Changes elsewhere in the page, such as ads or timestamps, do not cause an extraction.

OpenSooq's terms do not permit automated retrieval, and a web application firewall blocks heavy traffic. The tests use a local HTTP server with copies of the real JSON-LD; they make no request to OpenSooq.
