import { readFile } from 'node:fs/promises';
import { Pipeline, type Source } from 'elt';
import { installPostgresCatalog, PostgresSyncHistory } from 'elt-postgresql';
import { scratchWarehouse } from 'elt-postgresql/testing';
import { warehouseConnection } from '../warehouse-connection.ts';

const contract = new URL(
  '../../../../infra/init/marts/contract.sql',
  import.meta.url,
);

// One Apple source loaded as the service loads it, into a scratch warehouse
// the reader sees through marts/contract.sql.
export async function appleWarehouse(
  name: string,
  source: Source,
  outputs: string,
) {
  const warehouse = await scratchWarehouse(await readFile(contract, 'utf8'));
  const history = new PostgresSyncHistory({ url: warehouse.url });
  await history.install();
  await installPostgresCatalog({ url: warehouse.url, schema: 'marts' });
  const load = async () =>
    new Pipeline({
      history,
      connections: [
        await warehouseConnection(name, source, {
          url: warehouse.url,
          outputs,
        }),
      ],
    }).run();
  return { ...warehouse, load };
}
