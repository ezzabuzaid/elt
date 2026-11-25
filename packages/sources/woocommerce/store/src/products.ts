import { AdaptiveRevisit, PaginationReader } from '@eltjs/sdk-web-crawler';
import { WebStream } from '@eltjs/source-web-pages/web-stream';

import { StoreApiExtractor } from './store-api-extractor.ts';

/**
 * The products of the WooCommerce shops whose Store API products URLs are
 * the inputs, such as https://highhawks.jo/wp-json/wc/store/v1/products?per_page=100:
 * PaginationReader follows each page's Link: rel="next" header and hands back
 * every page of the list, and StoreApiExtractor gives each page's products.
 */
export const products = new WebStream({
  name: 'woocommerce_products',
  // The post id is the key that WooCommerce's database enforces (elt ADR 0022).
  primaryKey: ['productId'],
  readers: [new PaginationReader()],
  // A page of the list changes when one of its products does.
  revisit: new AdaptiveRevisit(),
  extractor: new StoreApiExtractor(),
});
