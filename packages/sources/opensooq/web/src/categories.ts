import { StartReader } from '@eltjs/sdk-web-crawler';
import { WebStream } from '@eltjs/source-web-pages/web-stream';

import { CategoryExtractor } from './category-extractor.ts';

/** The categories of the home pages given as inputs, read from each page's hidden menu; no category page is requested. */
export const categories = new WebStream({
  name: 'opensooq_categories',
  // A category's place in the menu of its page; the menu may link one URL twice (ADR 0022).
  primaryKey: ['pageUrl', 'position'],
  readers: [new StartReader()],
  extractor: new CategoryExtractor(),
});
