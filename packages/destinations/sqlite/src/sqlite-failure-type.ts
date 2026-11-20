import { UnavailableError } from '@zukhruf/sqlite-open';

import type { FailureType } from '@eltjs/elt';

// SQLite's READONLY (8), a file that this process may not write, and NOTADB
// (26), a file at the path that is not a database: a person must change the
// file or the path.
const sqliteCodes = new Set([8, 26]);

// The codes of the file system for a folder that this process may not write
// (EACCES, EPERM) or that is on a read-only file system (EROFS), such as the
// folder of the locks beside a checkpoint file.
const fileSystemCodes = new Set(['EACCES', 'EPERM', 'EROFS']);

// What kind of failure an error of a SQLite file that the destination or the
// checkpoint store writes is: config for a file that cannot be opened, which
// @zukhruf/sqlite-open gives as an UnavailableError, and for an error with
// one of sqliteCodes or fileSystemCodes; system for every other error.
export function failureType(error: unknown): FailureType {
  return error instanceof UnavailableError ||
    (Error.isError(error) &&
      (('errcode' in error &&
        typeof error.errcode === 'number' &&
        sqliteCodes.has(error.errcode)) ||
        ('code' in error &&
          typeof error.code === 'string' &&
          fileSystemCodes.has(error.code))))
    ? 'config'
    : 'system';
}
