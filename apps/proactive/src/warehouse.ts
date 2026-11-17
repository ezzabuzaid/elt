// The loading role, which owns the raw schemas, _warehouse and the marts.
export const warehouseUrl =
  'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';

// The role that rules read as, which can read the marts and nothing else.
export const readerUrl =
  'postgres://agent_reader:agent@127.0.0.1:55432/warehouse';
