import { fileURLToPath } from 'node:url';

// The folder holding the connectors this library ships, one folder per Apple
// app with its manifest and entry point.
export const builtInConnectors = fileURLToPath(new URL('.', import.meta.url));
