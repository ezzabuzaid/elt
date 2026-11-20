import { quote } from './sql-server-identifiers.ts';

// The two schemas of a warehouse, as in elt-postgresql: readers query the
// views of marts, and elt keeps each table of its own in _warehouse.
export const marts = 'marts';
export const warehouse = '_warehouse';

// A relation of marts or of _warehouse, as T-SQL names it.
export const inMarts = (name: string) => `${quote(marts)}.${quote(name)}`;
export const inWarehouse = (name: string) =>
  `${quote(warehouse)}.${quote(name)}`;
