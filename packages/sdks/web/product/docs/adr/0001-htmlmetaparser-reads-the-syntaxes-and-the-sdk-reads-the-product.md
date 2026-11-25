# htmlmetaparser reads the syntaxes and the SDK reads the product

A shop writes its product in one of two syntaxes. On 2026-11-24, of the 18 Jordanian shop hosts that declared a schema.org `Product`, 16 wrote JSON-LD and 2 microdata only. JSON-LD is JSON in a script element. Microdata is an algorithm over the element tree (WHATWG HTML, "Microdata"): `itemscope`, `itemprop`, `itemref`, and the value of each element type. Python's extruct, which Zyte and Scrapy use, reads both, and RDFa, Open Graph, microformats and Dublin Core too, and turns microdata into JSON-LD-like objects (`uniform=True`).

The candidates in Node, read and probed on 2026-11-24:

- `htmlmetaparser` 2.1.3 (Apache-2.0, last release 2023-12-07): a handler of htmlparser2's parser, with no DOM. It gives JSON-LD blocks as parsed, and microdata and RDFa in JSON-LD form, with relative URLs resolved and `content` read on every element. On three live pages it gave leaders.jo's WooCommerce `@graph` with its `Product`, timemachine.jo's microdata `Product` with `price`, `priceCurrency` and `image`, and citycenter.jo's OpenCart `Product` with `model`. It neither repairs JSON-LD nor flattens `@graph`.
- `@marbec/web-auto-extractor` 2.2.1 (MIT, maintained): no dependency, but it groups items by type, so it loses their order and nesting, it does not resolve URLs, and it drops the parent `@context` of `@graph` items.
- `metascraper` 5.58.7: JSON-LD only, as a property lookup.
- `microdata-node` 2.0.0, `microdata-rdf-streaming-parser` 3.1.0: microdata only, or RDF quads that the caller turns back into objects.
- jsdom, which `@eltjs/sdk-web-article` and the OpenSooq extractor use for their JSON-LD: a whole DOM, and no microdata.

## Decision

1. **htmlmetaparser reads the syntaxes.** It is the one candidate that gives both syntaxes as objects, with no DOM, on htmlparser2, which elt's lockfile already installs (12.0.0, through other packages).
2. **The SDK repairs and flattens JSON-LD itself.** A block that `JSON.parse` refuses is repaired with jsonrepair, as metascraper does; HTML entities stay as written, because a script element's text is raw. Each block's arrays and `@graph` are flattened, and an object that only names an `@id` takes the object of that `@id`, as Google's variant examples point `isVariantOf` to its group.
3. **The SDK unwraps microdata.** htmlmetaparser gives each value as an array of `{ "@value", "@language" }`; the SDK reads one value as its first `@value`, as JSON-LD gives it.
4. **The SDK knows the product.** No candidate chooses a page's product or its price.

## Considered Options

- **jsdom, as the article SDK.** It reads no microdata, and two of the 18 shops write nothing else. This option was rejected.
- **Microdata by hand.** It is a short WHATWG algorithm, but htmlmetaparser already follows `itemref` and resolves URLs. This option was rejected.
- **`@marbec/web-auto-extractor`.** It loses the order and nesting that the choice of the page's product needs. This option was rejected.
- **htmlmetaparser, and the SDK repairs, flattens and unwraps.** This option was selected.

## Consequences

- The SDK depends on htmlmetaparser, htmlparser2 and jsonrepair.
- htmlmetaparser has had no release since 2023. Its contract is htmlparser2's handler interface, which htmlparser2 12 still keeps; a break shows in this SDK's tests.
- The JSON-LD reading of `@eltjs/sdk-web-article` and of the OpenSooq extractor stays where it is: each is a few lines on the jsdom that its package already parses with, and a little copying is better than a little dependency.
