import { EnvelopeIndex } from './envelope-index.ts';
import { MailSchemaError, MailUnavailableError } from './errors.ts';
import { MailFiles } from './mail-files.ts';
import {
  envelopeIndexPath,
  mailDirectory,
  mailVersionDirectory,
} from './mail-location.ts';
import { MailVersion } from './mail-version.ts';

// One read of Mail's current version folder: its index pinned to one moment,
// and its files listed once. The two are separate: Mail writes files apart
// from the index, so a file read checks the file's version around it.
export class MailSnapshot implements Disposable {
  readonly directory: string;
  readonly index: EnvelopeIndex;
  readonly files: MailFiles;

  constructor(directory: string, index: EnvelopeIndex, files: MailFiles) {
    this.directory = directory;
    this.index = index;
    this.files = files;
  }

  [Symbol.dispose](): void {
    this.index[Symbol.dispose]();
  }
}

// Mail's store under its root, such as ~/Library/Mail, read without Mail,
// which need not run.
export class MailStore {
  readonly root: string;

  constructor(root: string = mailDirectory) {
    this.root = root;
  }

  async open(): Promise<MailSnapshot> {
    const directory = await this.#versionDirectory();
    const index = this.#index(directory);
    try {
      return new MailSnapshot(
        directory,
        index,
        await MailFiles.read(directory),
      );
    } catch (error) {
      index[Symbol.dispose]();
      throw error;
    }
  }

  // A probe whose current value changes when the store does.
  async version(): Promise<MailVersion> {
    return new MailVersion(this.root, await mailVersionDirectory(this.root));
  }

  // Any failure to find the current version folder is the store's grant,
  // except a folder name Mail no longer writes.
  async #versionDirectory(): Promise<string> {
    try {
      return await mailVersionDirectory(this.root);
    } catch (cause) {
      if (cause instanceof MailSchemaError) throw cause;
      throw new MailUnavailableError(this.root, cause);
    }
  }

  // Full Disk Access covers the whole store, so an index this process cannot
  // open names the store's root.
  #index(directory: string): EnvelopeIndex {
    try {
      return new EnvelopeIndex(envelopeIndexPath(directory));
    } catch (error) {
      if (error instanceof MailUnavailableError)
        throw new MailUnavailableError(this.root, error.cause);
      throw error;
    }
  }
}
