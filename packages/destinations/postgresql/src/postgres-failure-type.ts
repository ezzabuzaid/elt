import postgres from 'postgres';

import type { FailureType } from '@eltjs/elt';

// The SQLSTATE codes of a setup that a person must change: a role without
// the privilege that a statement needs (42501), a password the server
// refuses (28P01), a role that may not log in (28000), and a database that
// is not there (3D000).
const configCodes = new Set(['42501', '28P01', '28000', '3D000']);

// What kind of failure an error of the database that the destination or the
// checkpoint store writes is: config for an error of the server with one of
// configCodes; system for every other error, such as a server that cannot be
// reached.
export function failureType(error: unknown): FailureType {
  return error instanceof postgres.PostgresError && configCodes.has(error.code)
    ? 'config'
    : 'system';
}
