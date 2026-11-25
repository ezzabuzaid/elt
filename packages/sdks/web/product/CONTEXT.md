# Web product

The product that a shop's page declares in its schema.org data.

## Language

**Product**:
The thing that a page offers for sale, as one record: a schema.org `Product`, or a `ProductGroup` with its variants.
_Avoid_: Item, listing, article

**Page's product**:
The product that the page is about: the one whose `url` or `@id` is the page's URL, else the only top-level one. Related products and carousels are not it.
_Avoid_: Main product, primary product

**Syntax**:
The way the page writes its data: JSON-LD in a `<script type="application/ld+json">`, or microdata in `itemscope` and `itemprop` attributes.
_Avoid_: Format, markup

**Price**:
The amount to pay now, as a decimal string, with its currency, the regular price before a sale, and the range of an `AggregateOffer`.
_Avoid_: Cost, offer price

**Regular price**:
The price before a sale, from a price specification that is marked `StrikethroughPrice`, `ListPrice`, `RegularPrice`, `MSRP` or `SRP`, kept only when it is higher than the price.
_Avoid_: Old price, list price, original price

**Variant**:
One product of a `ProductGroup`, such as one size or one colour, with its own identifiers and price.
_Avoid_: Option, SKU

**Identifier**:
A value that names the product outside the page: `gtin*` (a barcode number), `mpn` (the maker's part number), `model`, `sku` (the shop's own) and `productID`.
_Avoid_: Code, ID
