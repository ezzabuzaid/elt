# The price is Google's active price, and a struck price is the regular price

A product's price has several forms in schema.org. `Offer.price` is a number or a text. `Offer.priceSpecification` is one or more `UnitPriceSpecification`, each with a `priceType`: WooCommerce 11.3.1 gives a simple product on sale its sale price with no `priceType` and its regular price with `ListPrice` (`class-wc-structured-data.php`, lines 342 to 533), and sets `offer.price` to the sale price; WPSSO marks the regular price `StrikethroughPrice`. A variable product gets an `AggregateOffer` with `lowPrice` and `highPrice`. Shopify gives a product with variants as a `ProductGroup`. schema.org itself sets no order between `price` and `priceSpecification`.

Google's merchant listing documentation, read on 2026-11-24, sets the order: "If you use both the offers.price and offers.priceSpecification properties to encode an active price, Google will use the price provided through the offers.price property and ignore the offers.priceSpecification property." "Active prices have neither a priceType nor a validForMemberTier property. Strikethrough prices set the priceType property to StrikethroughPrice (for a transition period, ListPrice is also allowed)." A sale's dates are `validFrom` and `validThrough`. Zyte's `regularPrice` "must be None if price is None" and "must be higher than price". Diffbot gives the lowest price of a range as `offerPrice`, and the range as `priceRange`.

## Decision

1. **The price to pay is Google's active price.** `offers.price` when the offer gives it; else the price specification with no `priceType`, or with `SalePrice`, and no `validForMemberTier`, whose `validFrom` and `validThrough` hold `at`.
2. **The regular price is the struck price.** A specification whose `priceType` is `StrikethroughPrice`, `ListPrice`, `RegularPrice`, `MSRP` or `SRP` is the regular price, kept only when it is higher than the price to pay.
3. **An AggregateOffer gives its range.** The amount is its `lowPrice`, and the range is `lowPrice` to `highPrice`. When it nests `offers`, they decide.
4. **Of several offers, the lowest in stock wins, in one currency.** Offers in another currency than the first offer's are not compared.
5. **A ProductGroup's price is its variant's.** The variant that the page's URL names (Shopify's `?variant=` with the variant's id in its `url` or `sku`) gives the price, else the cheapest variant.
6. **A price is a decimal string.** schema.org asks for `.` as the point and no symbol. The SDK keeps the digits as written, so JOD's `12.000` stays three decimals. It reads a number as its shortest decimal text, removes a currency symbol and a comma (a thousands separator), and reads Arabic-Indic digits as digits. A price that is still not a decimal is no price, and so is a price of zero, as Google's merchant listings need "a price greater than zero": a shop writes zero for "price on request", and a search would show it as the cheapest. A currency is kept as the shop gives it.
7. **The time is an input.** `at` is when the page was downloaded, so the SDK reads no clock (zukhruf ADR 0004).

## Considered Options

- **The first price of the page.** A WooCommerce page on sale lists its regular price in its specifications too. This option was rejected.
- **`priceSpecification` before `price`.** Against Google's documented order. This option was rejected.
- **Numbers.** A float loses JOD's three decimals and rounds other prices. This option was rejected.
- **Google's order, Zyte's regular price and Diffbot's range.** This option was selected.

## Consequences

- A price in a specification whose sale ended before `at` is not the price, and the regular price or the offer's own price is.
- A host that compares prices compares decimal strings as decimals, in one currency.
