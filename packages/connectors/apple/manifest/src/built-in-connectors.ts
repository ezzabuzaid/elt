import { fileURLToPath } from 'node:url';

// The folder holding the built-in connectors: the connector packages beside
// this one, each declaring itself in its package.json.
export const builtInConnectors = fileURLToPath(
  new URL('../..', import.meta.url),
);
