import { StartReader } from '@workspace/sdk-web-crawler';
import { WebStream } from '@workspace/source-web-pages/web-stream';

import { CategoryExtractor } from './category-extractor.ts';

/** The categories of the home pages given as inputs, read from each page's hidden menu; no category page is requested. */
export const categories = new WebStream({
  name: 'opensooq_categories',
  primaryKey: ['url'],
  readers: [new StartReader()],
  extractor: new CategoryExtractor(),
});
