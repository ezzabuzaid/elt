import { Gauge } from '@zukhruf/async';
import { FileStamps, isErrno } from '@zukhruf/fs';

// What the file system answers for a store that is not there, or that macOS
// keeps from a process without Full Disk Access.
const refusals = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'];

// What a change watcher reads of one store of an app that the app writes as
// files, such as a property list it rewrites whole: the file stamps of its
// files. files lists them at each read, so a file the app adds is a change,
// and a missing file has a stamp of its own. A store whose files cannot be
// listed, or that this process may not read, reads as unavailable, as an
// AppDatabaseVersion reads one. Its appearance, or a grant of access, is thus
// a change, and the read of its streams reports why (elt ADR 0020). Any other
// error fails the read.
export class AppFilesVersion extends Gauge<string> {
  readonly #files: () => readonly string[];

  constructor(files: () => readonly string[]) {
    super();
    this.#files = files;
  }

  protected async read(): Promise<string> {
    try {
      return String(await FileStamps.read(this.#files()));
    } catch (error) {
      if (refusals.some((code) => isErrno(error, code))) return 'unavailable';
      throw error;
    }
  }
}
