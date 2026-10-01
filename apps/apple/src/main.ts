import { installPostgresCatalog } from 'elt-postgresql';
import pipeline, { history, warehouseUrl } from './pipeline.ts';

await history.install();
await installPostgresCatalog({ url: warehouseUrl, schema: 'marts' });

const stopping = new AbortController();
process.once('SIGINT', () => stopping.abort());
process.once('SIGTERM', () => stopping.abort());
// Every connection's first pass loads all its streams; after that, each one
// refreshes when its own source reports a change. Every pass is recorded in
// the warehouse's sync history as it completes.
for await (const _pass of pipeline.watch({ signal: stopping.signal }));
