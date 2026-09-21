import { FileRead } from './file-read.ts';

// A destination declaration supplies its source requirements without doing I/O.
export abstract class Target {
  readonly fileReads: readonly FileRead[];

  constructor(fileReads: readonly FileRead[] = []) {
    if (
      !Array.isArray(fileReads) ||
      !fileReads.every((read) => read instanceof FileRead)
    )
      throw new TypeError('Targets require FileRead declarations');
    const names = fileReads.map((read) => read.name.toLowerCase());
    if (new Set(names).size !== names.length)
      throw new TypeError('Duplicate file field names');
    this.fileReads = Object.freeze([...fileReads]);
  }
}
