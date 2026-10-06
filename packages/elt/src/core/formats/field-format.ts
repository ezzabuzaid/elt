// The canonical spelling a string field declares through `format` or
// `contentEncoding`, and how two canonical values order when a copy compares
// them as cursors.
export abstract class FieldFormat {
  abstract readonly name: string;
  // False when byte order is not the values' order, so the field cannot be a
  // cursor.
  readonly orderable: boolean = true;
  // How cursors of this format compare, as target descriptions state it.
  readonly ordering: string = 'by byte order';

  abstract accepts(value: string): boolean;

  // Canonical values of one field share a width, so their bytes sort as they do.
  compare(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
  }
}
