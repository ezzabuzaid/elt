import {
  CompositeDataset,
  type Connection,
  type DerivedDataset,
  DocumentText,
} from '@eltjs/elt';
import {
  ComputedDataset,
  SqlServerDestination,
  SqlServerTable,
  View,
  inMarts,
  inWarehouse,
  literal,
  marts,
  quote,
  rawTable,
  sameDatabase,
} from '@eltjs/elt-sqlserver';
import { Embedding } from '@eltjs/embedding';

import { copiesInto } from '../copies.ts';
import { refuseUndeclaredColumns } from '../declared-columns.ts';
import {
  type ChunkingOptions,
  type EmbeddingOptions,
  type Loading,
  type SourceKey,
  keyColumns,
  refuseColumns,
} from '../options.ts';
import { passageRule } from '../passage-rules.ts';
import { KeywordIndex, mostIdCharacters } from './keyword-index.ts';

// Where the source rows are: the target of a copy in the database into, or a
// View, which names its own database, so no second database can disagree
// with it.
type Origin =
  | { readonly into: SqlServerDestination; readonly from: SqlServerTable }
  | { readonly from: View };

// The relations of the contract, in the option shapes of the SQL Server store
// and retrievers of @zukhruf/retrieval: SqlServerPassageStore({ session,
// schema, passages }), SqlServerEmbeddingRetriever({ store, vectors, model })
// and SqlServerKeywordRetriever({ store, index }).
export type SqlServerContract = {
  readonly schema: string;
  readonly passages: string;
  readonly vectors: string;
  readonly index: { readonly table: string };
};

// The columns of the passages of @zukhruf/retrieval on SQL Server, which no
// metadata column may take (its ADR 0001).
const contractColumns = [
  'id',
  'source',
  'seq',
  'start',
  'end',
  'text',
] as const;

// The collation of every passage id and source that the views compare:
// UTF-16 code units, so a and A are two sources under a case-insensitive
// database, as elt keeps them apart (elt-sqlserver ADR 0004).
const binary = 'COLLATE Latin1_General_100_BIN2';

// The language of the keyword index when the host names none: English, the
// LCID 1033, as the Postgres vectorizer reads English when it names none.
const english = 1033;

// One declaration that keeps the passage contract of @zukhruf/retrieval in
// step with what a pipeline loads into one SQL Server database: the passages
// of each source row with its metadata, the vector of each passage with the
// identity of its model, and a keyword index of the passages, a full-text
// index (ADR 0001). Each relation is a member that the pipeline refreshes in
// order, so a member's failure fails only the vectorizer (elt ADR 0034). The
// views of the contract live in marts and read the raw tables in _warehouse,
// the rows of now; a reader with SELECT on marts reads them through the
// ownership chain. Every relation's name starts with name.
export class Vectorizer extends CompositeDataset<SqlServerTable> {
  readonly name: string;
  readonly members: readonly [
    DerivedDataset<SqlServerTable>,
    ...DerivedDataset<SqlServerTable>[],
  ];
  readonly contract: SqlServerContract;
  // The database of the relations, which a host connects to for the store.
  readonly into: SqlServerDestination;
  readonly #from: SqlServerTable | View;
  readonly #key: SourceKey;
  readonly #loading: Loading;
  readonly #metadata: readonly string[];

  // name: the start of the name of each relation. key: the column, or
  // columns, that identify a source row. loading: what text of a row the
  // passages cut. metadata: the columns of the source row that each passage
  // gives beside its text; none when absent (Airbyte metadata_fields).
  // keywords: the LCID of the language of the full-text index, 1033
  // (English) when absent. indexing: the index of the vectors, which is none:
  // a search compares every vector with VECTOR_DISTANCE, as the DiskANN
  // index of SQL Server 2025 does not serve the contract yet (zukhruf #5475).
  constructor(
    options: Origin & {
      readonly name: string;
      readonly description: string;
      readonly key: SourceKey;
      readonly loading: Loading;
      readonly chunking: ChunkingOptions;
      readonly embedding: EmbeddingOptions;
      readonly metadata?: readonly string[];
      readonly keywords?: { readonly language?: number };
      readonly indexing?: { readonly vectors: 'none' };
    },
  ) {
    super();
    const { name, description, key, loading, chunking, embedding } = options;
    const metadata = options.metadata ?? [];
    refuseColumns({
      vectorizer: name,
      key,
      metadata,
      contract: contractColumns,
    });
    this.name = name;
    this.into = 'into' in options ? options.into : options.from.into;
    this.#from = options.from;
    this.#key = key;
    this.#loading = loading;
    this.#metadata = Object.freeze([...metadata]);
    const into = this.into;
    const columns = keyColumns(key);
    const source =
      options.from instanceof SqlServerTable
        ? inWarehouse(options.from.raw)
        : inMarts(options.from.name);
    const keyDescriptions = Object.fromEntries(
      columns.map((column) => [
        column,
        `The ${column} column of the key of the source row.`,
      ]),
    );
    const names = {
      text: `${name}_text`,
      documents: `${name}_documents`,
      chunks: `${name}_chunks`,
      keywords: `${name}_keywords`,
      passages: `${name}_passages`,
      chunkTexts: `${name}_chunk_texts`,
      chunkVectors: `${name}_chunk_vectors`,
      passageVectors: `${name}_passage_vectors`,
      status: `${name}_status`,
    };
    const rawParts = rawTable(`${names.chunks}_parts`);
    const parts = inWarehouse(rawParts);
    const vectors = inWarehouse(rawTable(names.chunkVectors));

    // The text of a stored file is the input of the chunks through a view
    // keyed by the source key, since rows can share a file (elt ADR 0027).
    // Names of files compare by their bytes (elt-sqlserver ADR 0015).
    let files: readonly [] | readonly [ComputedDataset<string>, View] = [];
    let input: SqlServerTable | View = options.from;
    if ('file' in loading) {
      const text = new ComputedDataset({
        into,
        name: names.text,
        description: `The text of each file of the vectorizer ${name}. ${description}`,
        from: [options.from],
        compute: new DocumentText({
          parser: loading.parser,
          files: loading.files,
          column: loading.file,
        }),
      });
      input = new View({
        into,
        name: names.documents,
        description: `The text of the file of each source row of the vectorizer ${name}. ${description}`,
        columns: {
          ...keyDescriptions,
          content: 'The text the parser extracted from the file.',
        },
        sql: `SELECT ${columns.map((column) => `s.${quote(column)}`).join(', ')}, t.[content] FROM ${source} AS s JOIN ${inMarts(names.text)} AS t ON t.[ref] ${binary} = s.${quote(loading.file)} ${binary} WHERE t.[status] = N'computed'`,
      });
      files = [text, input];
    }
    const chunks = new ComputedDataset({
      into,
      name: names.chunks,
      description: `The passages of the vectorizer ${name}, one row for each source row. ${description}`,
      from: [input],
      // A passage id is the key of the keyword index, NVARCHAR(450), so an
      // input with a longer id is a rule failure of its own.
      compute: passageRule({
        key,
        fields: 'columns' in loading ? loading.columns : ['content'],
        chunking,
        maxIdLength: mostIdCharacters,
      }),
    });
    const keywords = new KeywordIndex({
      into,
      name: names.keywords,
      parts: rawParts,
      language: options.keywords?.language ?? english,
    });
    // The source joins as text, in binary: the source of a passage is the
    // text of the key value as the destination reads it back.
    const keyText = (column: string) =>
      `CONVERT(NVARCHAR(MAX), s.${quote(column)}) ${binary}`;
    const join =
      typeof key === 'string'
        ? `${keyText(key)} = p.[source] ${binary}`
        : columns
            .map(
              (column, index) =>
                `${keyText(column)} = JSON_VALUE(p.[source], '$[${index}]') ${binary}`,
            )
            .join(' AND ');
    const passages = new View({
      into,
      name: names.passages,
      description: `The passages of the vectorizer ${name}, as @zukhruf/retrieval reads them. ${description}`,
      columns: {
        id: 'The id of the passage: its source, a colon and its seq.',
        source:
          'The key of the source row that the passage is cut from: the value of its key column, or the JSON array of the values of its key columns.',
        seq: 'The place of the passage in its source row, from 0.',
        start:
          'The offset of the first code point of the passage in the text of its row, from 0.',
        end: 'The offset after the last code point of the passage in the text of its row.',
        text: 'The text of the passage.',
        ...Object.fromEntries(
          metadata.map((column) => [
            column,
            `The ${column} column of the source row.`,
          ]),
        ),
      },
      sql: `SELECT CAST(k.[id] AS NVARCHAR(${mostIdCharacters})) ${binary} AS [id], p.[source], p.[seq], p.[start], p.[end], p.[text]${metadata
        .map((column) => `, s.${quote(column)} AS ${quote(column)}`)
        .join(
          '',
        )} FROM ${inMarts(names.keywords)} AS k JOIN ${parts} AS p ON p.[source] ${binary} = k.[source] AND p.[seq] = k.[seq] JOIN ${source} AS s ON ${join}`,
    });
    // The text of each part by its part hash. Parts with one text share a
    // part hash, and a computed dataset keeps the first input of a key, so a
    // text is embedded once with no DISTINCT.
    const chunkTexts = new View({
      into,
      name: names.chunkTexts,
      description: `The text of each passage of the vectorizer ${name}, by its part hash. ${description}`,
      columns: {
        id: 'The part hash of the passage.',
        text: 'The text of the passage.',
      },
      sql: `SELECT [part_hash] AS [id], [text] FROM ${inMarts(`${names.chunks}_parts`)}`,
    });
    // No vector index: indexing is { vectors: 'none' } only (zukhruf #5475).
    const chunkVectors = new ComputedDataset({
      into,
      name: names.chunkVectors,
      description: `The vector of each passage text of the vectorizer ${name}. ${description}`,
      from: [chunkTexts],
      compute: new Embedding({ ...embedding, key: 'id', fields: ['text'] }),
    });
    // A vector whose model failed is no answer to a search, so only computed
    // ones show. The rule names the model as the retriever reads it.
    const passageVectors = new View({
      into,
      name: names.passageVectors,
      description: `The vector of each passage of the vectorizer ${name}, as @zukhruf/retrieval reads them. ${description}`,
      columns: {
        id: 'The id of the passage.',
        vector: 'The unit vector of the passage text, float32 values.',
        model:
          'The model that made the vector: <provider>/<model id> (<n> dimensions).',
      },
      sql: `SELECT CONCAT(p.[source], N':', p.[seq]) ${binary} AS [id], v.[vector], v.[rule] AS [model] FROM ${parts} AS p JOIN ${vectors} AS v ON v.[id] = p.[part_hash] WHERE v.[status] = N'computed'`,
    });
    const leaves = [
      ...files,
      chunks,
      keywords,
      passages,
      chunkTexts,
      chunkVectors,
      passageVectors,
    ] as const;
    const status = new View({
      into,
      name: names.status,
      description: `How far the relations of the vectorizer ${name} are in step with their source. ${description}`,
      columns: {
        state:
          'failed when a relation failed, waiting when one waits for its input, refreshing when one refreshes, else current.',
        as_of:
          'The earliest as_of of the relations: the data that every relation holds. NULL until each holds some.',
        pending_sources: 'The source rows that wait for their passages.',
        pending_vectors: 'The passage texts that wait for their vectors.',
      },
      sql: `WITH [members] ([dataset]) AS (SELECT [dataset] FROM (VALUES ${leaves
        .map((member) => `(${literal(member.qualifiedName)})`)
        .join(
          ', ',
        )}) AS v ([dataset])), [rows] AS (SELECT m.[dataset], COALESCE(d.[state], N'waiting') AS [state], d.[as_of], COALESCE(d.[pending], 0) AS [pending] FROM [members] AS m LEFT JOIN ${inWarehouse('derived_status')} AS d ON d.[dataset] = m.[dataset]) SELECT CASE MAX(CASE [state] WHEN N'failed' THEN 3 WHEN N'waiting' THEN 2 WHEN N'refreshing' THEN 1 ELSE 0 END) WHEN 3 THEN N'failed' WHEN 2 THEN N'waiting' WHEN 1 THEN N'refreshing' ELSE N'current' END AS [state], CASE WHEN COUNT([as_of]) = COUNT(*) THEN MIN([as_of]) END AS [as_of], (SELECT [pending] FROM [rows] WHERE [dataset] = ${literal(chunks.qualifiedName)}) AS [pending_sources], (SELECT [pending] FROM [rows] WHERE [dataset] = ${literal(chunkVectors.qualifiedName)}) AS [pending_vectors] FROM [rows]`,
    });
    this.members = Object.freeze([...leaves, status]);
    this.contract = Object.freeze({
      schema: marts,
      passages: names.passages,
      vectors: names.passageVectors,
      index: Object.freeze({ table: names.keywords }),
    });
    Object.freeze(this);
  }

  // A source table must be one that a copy loads into the database of the
  // vectorizer, and the copy's stream must declare each column that the
  // vectorizer reads. A View's columns are its own SQL's, so its first
  // refresh tells, as for any view.
  override validate(connections: readonly Connection<SqlServerTable>[]): void {
    const from = this.#from;
    if (!(from instanceof SqlServerTable)) return;
    refuseUndeclaredColumns({
      vectorizer: this.name,
      from,
      copies: copiesInto(connections, (destination) =>
        sameDatabase(destination, this.into),
      ),
      destination: 'its database',
      key: this.#key,
      metadata: this.#metadata,
      loading: this.#loading,
    });
  }
}
