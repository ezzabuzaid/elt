import type { CopyConfiguration } from './copy-configuration.ts';
import type { FileRead } from './file-read.ts';

// A destination column as its description needs it.
export type DescribedColumn = {
  readonly name: string;
  readonly fileRead?: FileRead;
  readonly storesFile: boolean;
};

export type TargetDescription = {
  // The stream's own meaning, or null when its schema gives none.
  readonly meaning: string | null;
  readonly table: string;
  // Null where the stream's schema leaves a column undescribed.
  readonly columns: Readonly<Record<string, string | null>>;
};

// JSON Schema annotations are optional; absent ones describe nothing.
function annotation(value: unknown): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    !value.isWellFormed()
  )
    throw new TypeError(
      'JSON Schema description must be well-formed text without NUL',
    );
  return value;
}

const loading = {
  append: 'Every accepted observation is appended; source keys may repeat.',
  overwrite: 'Each full refresh replaces the table with its accepted records.',
  append_dedup: 'Accepted observations reconcile rows by the copy key.',
  overwrite_dedup:
    'Each full refresh replaces the table with deduplicated records.',
} as const;

// What every destination tells readers about a copy's target: the stream's
// meaning, how it is loaded, and each column from the stream's schema. Only
// where original file bytes are kept differs by destination.
export function describeTarget<Column extends DescribedColumn>(
  configuration: CopyConfiguration,
  columns: readonly Column[],
  storedFile: (column: Column) => string,
): TargetDescription {
  const { stream } = configuration;
  const meaning = annotation(stream.jsonSchema.description);
  const lines = [`Source stream: ${stream.name}.`];
  if (meaning !== null) lines.push(`Source record meaning: ${meaning}`);
  lines.push(
    `Extraction: ${configuration.syncMode}. Loading: ${configuration.destinationSyncMode}. ${loading[configuration.destinationSyncMode]}`,
  );
  if (configuration.dedupPolicy !== undefined) {
    const { primaryKey, cursorField } = configuration.deduplication();
    lines.push(`Copy key: ${primaryKey.join(', ')}.`);
    lines.push(
      configuration.dedupPolicy === 'replace'
        ? 'For a repeated key, the newest extracted record wins.'
        : `For a repeated key, the greatest ${cursorField} wins; equal cursors retain the first accepted record. Text cursors compare by byte order.`,
    );
  }
  const { properties } = stream.jsonSchema;
  const described: Record<string, string | null> = Object.fromEntries(
    columns.map((column) => {
      if (column.storesFile) return [column.name, storedFile(column)];
      if (column.fileRead?.parser !== undefined)
        return [
          column.name,
          `Text extracted from the source file by parser ${column.fileRead.parser.identity}. NULL when the source file is unavailable or the parser returns no text.`,
        ];
      if (column.fileRead?.file.storage !== undefined)
        return [
          column.name,
          `${column.fileRead.file.storage.reference} NULL when the source file is unavailable.`,
        ];
      return [column.name, annotation(properties?.[column.name]?.description)];
    }),
  );
  described.loaded_at =
    'Start time of the load that last wrote this row, not the source modification time or the most recent successful sync.';
  return Object.freeze({
    meaning,
    table: lines.join('\n'),
    columns: Object.freeze(described),
  });
}

// The parts a reader view still lacks: every column, and the stream itself,
// must be described before readers see it.
export function undescribed({ meaning, columns }: TargetDescription): string[] {
  const missing = Object.entries(columns).flatMap(([column, text]) =>
    text === null ? [column] : [],
  );
  if (meaning === null) missing.unshift('the stream');
  return missing;
}
