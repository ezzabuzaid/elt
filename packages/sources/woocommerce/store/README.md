# WooCommerce Store API

`products` is a `WebStream` for `WebSource` from `@eltjs/source-web-pages`. It reads the products of a WooCommerce shop through the shop's public Store API, `/wp-json/wc/store/v1/products`, for a shop whose product pages give no schema.org `Product` (`ProductExtractor` of `@eltjs/source-web-pages` reads those). On 2026-11-24, 10 of the 12 Jordanian WooCommerce shops without schema.org data answered the Store API.

```ts
import { WebSource } from '@eltjs/source-web-pages/web-source';
import { products } from '@eltjs/source-woocommerce-store/products';

const source = new WebSource({
  streams: [
    {
      stream: products,
      inputs: [
        'https://highhawks.jo/wp-json/wc/store/v1/products?per_page=100',
      ],
    },
  ],
  cachePath: './web-http.sqlite',
  userAgent: 'ExampleReader/1.0 (+https://example.com/contact)',
});
```

An input is the Store API products URL of one shop, with `per_page=100`, the most that the API gives. `PaginationReader` reads the next page from the response's `Link: rel="next"` header, as `@eltjs/sdk-web-crawler` reads a JSON list ([crawler ADR 0009](../../../sdks/web/crawler/docs/adr/0009-a-json-list-hands-back-each-of-its-pages.md)), and hands back every page, so `StoreApiExtractor` reads each page's products. The stream's key is `inputUrl` and `productId`: the id is the post id that WooCommerce's database enforces (elt ADR 0022).

## The record

| Column                              | From the Store API                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `productId`                         | `id`, as text                                                                                                                                                                                                                                                                                                                                                                      |
| `name`                              | `name`, with its HTML entities decoded (the API gives `Computers &amp; Laptops`)                                                                                                                                                                                                                                                                                                   |
| `url`                               | `permalink`                                                                                                                                                                                                                                                                                                                                                                        |
| `type`                              | `type`: `simple`, `variable`, `grouped` or `external`                                                                                                                                                                                                                                                                                                                              |
| `sku`                               | `sku`; null when it is empty                                                                                                                                                                                                                                                                                                                                                       |
| `description`, `shortDescription`   | `description`, `short_description`, as text                                                                                                                                                                                                                                                                                                                                        |
| `brand`                             | the first of `brands`; null when there is none                                                                                                                                                                                                                                                                                                                                     |
| `categories`                        | the names of `categories`, decoded                                                                                                                                                                                                                                                                                                                                                 |
| `images`                            | the `src` of `images`                                                                                                                                                                                                                                                                                                                                                              |
| `price`, `regularPrice`, `currency` | `prices`: the amounts are integers in the currency's minor unit, so `36900` with `currency_minor_unit` 2 is `369`; each is an exact decimal of one spelling, as `@eltjs/sdk-web-product` writes a price; a price of zero is no price (a shop writes it for "price on request"), and the regular price is kept only beside a price that it is higher than, as Zyte's `regularPrice` |
| `lowPrice`, `highPrice`             | `prices.price_range` of a variable product; null otherwise                                                                                                                                                                                                                                                                                                                         |
| `availability`                      | `BackOrder` when `is_on_backorder` (WooCommerce's `is_in_stock` is true then too), else `InStock` when `is_in_stock`, else `OutOfStock`, as schema.org names them                                                                                                                                                                                                                  |
| `ratingValue`, `ratingCount`        | `average_rating` and `review_count`; null when the product has no review                                                                                                                                                                                                                                                                                                           |
| `variationIds`                      | the ids of `variations`: the list response gives no variation's price                                                                                                                                                                                                                                                                                                              |

A page whose body is not a list of products, such as a plugin's error object, is a failed page: the extractor throws, the run reports it, the products of the other pages are stored, and the crawler asks the page again when it is due. A page's fingerprint is a hash of its URL and its records, and `AdaptiveRevisit` asks a page sooner when its body changed.

## Why not an npm package

The npm clients of the Store API (`@typewoo/sdk`, `wccart`, `@store-sdk/core`) send their own requests, for carts and checkout. Here the crawler sends the requests, with its politeness, cache and revisits, so the package reads a response that the crawler hands back, with a zod schema typed from a live response.
