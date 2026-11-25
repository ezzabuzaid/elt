# The page's product is the one whose URL is the page, else the only one

A product page often declares more than its product: related products, a carousel, or an `ItemList` of the products of a category. Google's product rich results "only support pages that focus on a single product (or multiple variants of the same product)". Diffbot flags a page with several products with `multipleProducts`. WooCommerce gives its product an `@id` of the page's URL with `#product`.

## Decision

1. **The page's product is the one whose URL is the page.** A `Product` or `ProductGroup` whose `url`, or whose `@id` without its fragment, is the page's URL or the canonical URL that the page declares is the page's product. The comparison ignores the scheme, the fragment and a trailing slash, and decodes percent-escapes, as leaders.jo writes its `@id` with Arabic letters and its page URL with escapes, and OpenSooq writes its listing's `url` with http on an https page.
2. **Else the only top-level one.** A product that no other object nests, such as in `isRelatedTo`, `isSimilarTo` or `itemListElement`, is top-level. When the page has one top-level product, it is the page's product.
3. **Else none.** When several top-level products remain and none is the page's, the page has no product. The SDK does not guess.
4. **A variant is not the page's product.** A `Product` that a `ProductGroup` names in `hasVariant`, or that names a group in `isVariantOf`, is a variant of that group.

## Considered Options

- **The first product of the page.** A related product before the product would be the page's product. This option was rejected.
- **The product with the most properties.** A guess, which a shop's carousel can win. This option was rejected.
- **The page's URL, then the only top-level product, then none.** This option was selected.

## Consequences

- A category page that lists products in an `ItemList` gives no product.
- A page whose product names a URL that is neither the page nor its declared canonical URL, and that also declares related products, gives no product.
- Each syntax is read on its own, JSON-LD first: a product that a page writes in both JSON-LD and microdata is one product, not two that leave the page with none.
