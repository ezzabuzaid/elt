import type { FailureType } from '@eltjs/elt';
import { SqlServerPermissionError } from '@eltjs/sdk-microsoft-sql-server';

import { SqlServerSetupError } from './sql-server-setup-error.ts';

// The numbers of the errors of SQL Server for a login without a permission
// that a statement needs: on an object (229) or a column (230), or in the
// database, such as CREATE TABLE (262).
const permissionNumbers = new Set([229, 230, 262]);

// What kind of failure an error of the database that the destination or the
// checkpoint store writes is: config for a database that is not set up as the
// destination needs it (SqlServerSetupError) and for a login without a
// permission (SqlServerPermissionError, or an error with one of
// permissionNumbers); system for every other error, such as a server that
// cannot be reached or a login that the server refuses.
export function failureType(error: unknown): FailureType {
  return error instanceof SqlServerSetupError ||
    error instanceof SqlServerPermissionError ||
    (Error.isError(error) &&
      'number' in error &&
      typeof error.number === 'number' &&
      permissionNumbers.has(error.number))
    ? 'config'
    : 'system';
}
