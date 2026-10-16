import { fileURLToPath } from 'node:url';

// The connectors whose counterparts the people model reads, each import
// attached under the connector's name.
export const peopleConnectors = [
  'contacts',
  'messages',
  'call-history',
  'mail',
  'whatsapp',
  'slack',
  'teams',
  'calendar',
] as const;

// The model: temporary views a reader creates on a connection with those
// imports attached, so nothing is stored in any import.
export const peopleFile = fileURLToPath(
  new URL('../people.sql', import.meta.url),
);
