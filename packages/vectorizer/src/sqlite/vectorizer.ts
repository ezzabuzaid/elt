import {
  CompositeDataset,
  type Connection,
  type DerivedDataset,
  DocumentText,
} from '@eltjs/elt';
import {
  ComputedDataset,
  SQLiteDestination,
  SQLiteTable,
  View,
  quote,
  rawTable,
} from '@eltjs/elt-sqlite';
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
import { KeywordIndex } from './keyword-index.ts';

// Where the source rows are: the target of a copy in the file into, or a
// View, which names its own file, so no second file can disagree with it.
type Origin =
  | { readonly into: SQLiteDestination; readonly from: SQLiteTable }
  | { readonly from: View };

// The relations of the contract, in the option shapes of the SQLite store and
// retrievers of @zukhruf/retrieval: SqlitePassageStore({ database, passages }),
// SqliteEmbeddingRetriever({ store, vectors, model }) and
// SqliteBM25Retriever({ store, index }).
export type SqliteContract = {
  readonly passages: string;
  readonly vectors: string;
  readonly index: string;
};

// The columns of the passages of @zukhruf/retrieval on SQLite, which no
// metadata column may take (its ADR 0001).
const contractColumns = [
  'rowid',
  'id',
  'source',
  'seq',
  'start',
  'end',
  'text',
] as const;

// One declaration that keeps the passage contract of @zukhruf/retrieval in
// step with what a pipeline loads into one SQLite file, as pgai's
// create_vectorizer does in Postgres: the passages of each source row with
// its metadata, the vector of each passage with the identity of its model,
// and a keyword index of the passages (ADR 0001). Each relation is a member
// that the pipeline refreshes in order, so a member's failure fails only the
// vectorizer (elt ADR 0034). Every relation's name starts with name.
export class Vectorizer extends CompositeDataset<SQLiteTable> {
  readonly name: string;
  readonly members: readonly [
    DerivedDataset<SQLiteTable>,
    ...DerivedDataset<SQLiteTable>[],
  ];
  readonly contract: SqliteContract;
  // The file of the relations, which a host opens for the store.
  readonly into: SQLiteDestination;
  readonly #from: SQLiteTable | View;
  readonly #key: SourceKey;
  readonly #loading: Loading;
  readonly #metadata: readonly string[];

  // name: the start of the name of each relation. key: the column, or
  // columns, that identify a source row. loading: what text of a row the
  // passages cut. metadata: the columns of the source row that each passage
  // gives beside its text; none when absent (Airbyte metadata_fields).
  constructor(
    options: Origin & {
      readonly name: string;
      readonly description: string;
      readonly key: SourceKey;
      readonly loading: Loading;
      readonly chunking: ChunkingOptions;
      readonly embedding: EmbeddingOptions;
      readonly metadata?: readonly string[];
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
      options.from instanceof SQLiteTable
        ? quote(options.from.raw)
        : quote(options.from.name);
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
      index: `${name}_passages_fts`,
    };
    const rawParts = rawTable(`${names.chunks}_parts`);
    const parts = quote(rawParts);
    const vectors = quote(rawTable(names.chunkVectors));

    // The text of a stored file is the input of the chunks through a view
    // keyed by the source key, since rows can share a file (elt ADR 0027).
    let files: readonly [] | readonly [ComputedDataset<string>, View] = [];
    let input: SQLiteTable | View = options.from;
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
        sql: `SELECT ${columns.map((column) => `s.${quote(column)}`).join(', ')}, t."content" FROM ${source} AS s JOIN ${quote(names.text)} AS t ON t."ref" = s.${quote(loading.file)} WHERE t."status" = 'computed'`,
      });
      files = [text, input];
    }
    const chunks = new ComputedDataset({
      into,
      name: names.chunks,
      description: `The passages of the vectorizer ${name}, one row for each source row. ${description}`,
      from: [input],
      compute: passageRule({
        key,
        fields: 'columns' in loading ? loading.columns : ['content'],
        chunking,
      }),
    });
    const keywords = new KeywordIndex({
      into,
      name: names.keywords,
      index: names.index,
      parts: rawParts,
    });
    const join =
      typeof key === 'string'
        ? `s.${quote(key)} = p."source"`
        : columns
            .map(
              (column, index) =>
                `s.${quote(column)} = json_extract(p."source", '$[${index}]')`,
            )
            .join(' AND ');
    const passages = new View({
      into,
      name: names.passages,
      description: `The passages of the vectorizer ${name}, as @zukhruf/retrieval reads them. ${description}`,
      columns: {
        rowid: 'The rowid of the passage in the keyword index.',
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
      sql: `SELECT k."rowid" AS "rowid", k."id", p."source", p."seq", p."start", p."end", p."text"${metadata
        .map((column) => `, s.${quote(column)} AS ${quote(column)}`)
        .join(
          '',
        )} FROM ${quote(names.keywords)} AS k JOIN ${parts} AS p ON p."source" = k."source" AND p."seq" = k."seq" JOIN ${source} AS s ON ${join}`,
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
      sql: `SELECT "part_hash" AS "id", "text" FROM ${quote(`${names.chunks}_parts`)}`,
    });
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
      sql: `SELECT p."source" || ':' || p."seq" AS "id", v."vector", v."rule" AS "model" FROM ${parts} AS p JOIN ${vectors} AS v ON v."id" = p."part_hash" WHERE v."status" = 'computed'`,
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
    const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
    // With no files, the text member is no member: the counts read 0.
    const [text] = files;
    const fileText = text ? literal(text.name) : 'NULL';
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
        failed_sources:
          'The source rows whose passages failed: a search finds none of their passages until a refresh cuts them.',
        failed_vectors:
          'The passage texts whose vectors failed: a search by meaning misses their passages until a refresh embeds them.',
        pending_files:
          'The stored files that wait for their text. 0 when the vectorizer loads columns.',
        failed_files:
          'The stored files whose text failed: no search finds the source rows of a file until a refresh reads it. 0 when the vectorizer loads columns.',
      },
      sql: `WITH "members" ("dataset") AS (VALUES ${leaves
        .map(({ name: member }) => `(${literal(member)})`)
        .join(
          ', ',
        )}), "rows" AS (SELECT m."dataset", coalesce(d."state", 'waiting') AS "state", d."as_of", coalesce(d."pending", 0) AS "pending", coalesce(d."failed", 0) AS "failed" FROM "members" AS m LEFT JOIN "derived_status" AS d ON d."dataset" = m."dataset") SELECT CASE max(CASE "state" WHEN 'failed' THEN 3 WHEN 'waiting' THEN 2 WHEN 'refreshing' THEN 1 ELSE 0 END) WHEN 3 THEN 'failed' WHEN 2 THEN 'waiting' WHEN 1 THEN 'refreshing' ELSE 'current' END AS "state", CASE WHEN count("as_of") = count(*) THEN min("as_of") END AS "as_of", (SELECT "pending" FROM "rows" WHERE "dataset" = ${literal(names.chunks)}) AS "pending_sources", (SELECT "pending" FROM "rows" WHERE "dataset" = ${literal(names.chunkVectors)}) AS "pending_vectors", (SELECT "failed" FROM "rows" WHERE "dataset" = ${literal(names.chunks)}) AS "failed_sources", (SELECT "failed" FROM "rows" WHERE "dataset" = ${literal(names.chunkVectors)}) AS "failed_vectors", coalesce((SELECT "pending" FROM "rows" WHERE "dataset" = ${fileText}), 0) AS "pending_files", coalesce((SELECT "failed" FROM "rows" WHERE "dataset" = ${fileText}), 0) AS "failed_files" FROM "rows"`,
    });
    this.members = Object.freeze([...leaves, status]);
    this.contract = Object.freeze({
      passages: names.passages,
      vectors: names.passageVectors,
      index: names.index,
    });
    Object.freeze(this);
  }

  // A source table must be one that a copy loads into the file of the
  // vectorizer, and the copy's stream must declare each column that the
  // vectorizer reads. A View's columns are its own SQL's, so its first
  // refresh tells, as for any view.
  override validate(connections: readonly Connection<SQLiteTable>[]): void {
    const from = this.#from;
    if (!(from instanceof SQLiteTable)) return;
    refuseUndeclaredColumns({
      vectorizer: this.name,
      from,
      copies: copiesInto(
        connections,
        (destination) =>
          destination instanceof SQLiteDestination &&
          destination.path === this.into.path,
      ),
      destination: this.into.path,
      key: this.#key,
      metadata: this.#metadata,
      loading: this.#loading,
    });
  }
}
