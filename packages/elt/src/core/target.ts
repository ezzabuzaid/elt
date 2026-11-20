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

// A column of a target that the host declares, as each destination's column
// class holds it.
export type TargetColumn = {
  readonly field: string;
  readonly kind: string;
  readonly isPrimaryKey: boolean;
  readonly fileRead?: FileRead;
};

// The file reads of the columns that a host declares for a target, which each
// hold one field: at most one of them is the key, and a column that holds a
// file has the kind of what its read gives.
export function targetFileReads(
  columns: readonly TargetColumn[],
): readonly FileRead[] {
  const fields = columns.map((column) => column.field);
  if (new Set(fields).size !== fields.length)
    throw new TypeError('Two columns hold one field');
  if (columns.filter((column) => column.isPrimaryKey).length > 1)
    throw new TypeError('Only one primary-key column is supported');
  const fileReads: FileRead[] = [];
  for (const { fileRead, kind } of columns) {
    if (fileRead === undefined) continue;
    if (fileRead.outputType === 'bytes' ? kind !== 'blob' : kind !== 'text')
      throw new TypeError(
        'Original files require a BLOB column; parsed text and stored references require a TEXT column',
      );
    fileReads.push(fileRead);
  }
  return fileReads;
}
