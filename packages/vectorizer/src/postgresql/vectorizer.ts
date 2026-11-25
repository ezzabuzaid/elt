import {
  CompositeDataset,
  type Connection,
  type DerivedDataset,
  DocumentText,
} from '@eltjs/elt';
import {
  ComputedDataset,
  type Hnsw,
  PostgresDestination,
  type PostgresIndex,
  PostgresTable,
  View,
  hnsw,
  inMarts,
  inWarehouse,
  marts,
  quote,
  rawTable,
} from '@eltjs/elt-postgresql';
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

// Where the source rows are: the target of a copy in the database into, or a
// View, which names its own database, so no second database can disagree
// with it.
type Origin =
  | { readonly into: PostgresDestination; readonly from: PostgresTable }
  | { readonly from: View };

// The relations of the contract, in the option shapes of the Postgres store
// and retrievers of @zukhruf/retrieval: PostgresPassageStore({ session,
// schema, passages }), PgvectorEmbeddingRetriever({ store, vectors, model })
// and PgvectorKeywordRetriever({ store, index }).
export type PostgresContract = {
  readonly schema: string;
  readonly passages: string;
  readonly vectors: string;
  readonly index: { readonly column: string; readonly configuration: string };
};

// The columns of the passages of @zukhruf/retrieval on Postgres, which no
// metadata column may take: the passage columns of its ADR 0001 and the
// keywords column of its ADR 0004.
const contractColumns = [
  'id',
  'source',
  'seq',
  'start',
  'end',
  'text',
  'keywords',
] as const;

// One declaration that keeps the passage contract of @zukhruf/retrieval in
// step with what a pipeline loads into one Postgres database, as pgai's
// create_vectorizer does: the passages of each source row with its metadata,
// the vector of each passage with the identity of its model, and a keyword
// index of the passages (ADR 0001). Each relation is a member that the
// pipeline refreshes in order, so a member's failure fails only the
// vectorizer (elt ADR 0034). The views of the contract live in marts and read
// the raw tables in _warehouse, the rows of now, so a search uses the HNSW
// index of the vectors and the GIN index of the keywords. Every relation's
// name starts with name.
export class Vectorizer extends CompositeDataset<PostgresTable> {
  readonly name: string;
  readonly members: readonly [
    DerivedDataset<PostgresTable>,
    ...DerivedDataset<PostgresTable>[],
  ];
  readonly contract: PostgresContract;
  // The database of the relations, whose URL a host opens for the store.
  readonly into: PostgresDestination;
  readonly #from: PostgresTable | View;
  readonly #key: SourceKey;
  readonly #loading: Loading;
  readonly #metadata: readonly string[];

  // name: the start of the name of each relation. key: the column, or
  // columns, that identify a source row. loading: what text of a row the
  // passages cut. metadata: the columns of the source row that each passage
  // gives beside its text; none when absent (Airbyte metadata_fields).
  // keywords: the text search configuration of the keyword index, 'english'
  // when absent, as PgvectorKeywordRetriever reads it. indexing: the index of
  // the vectors, an HNSW index with pgvector's own build when absent (pgai
  // ai.indexing_hnsw), or none, so a search compares every vector (pgai
  // ai.indexing_none).
  constructor(
    options: Origin & {
      readonly name: string;
      readonly description: string;
      readonly key: SourceKey;
      readonly loading: Loading;
      readonly chunking: ChunkingOptions;
      readonly embedding: EmbeddingOptions;
      readonly metadata?: readonly string[];
      readonly keywords?: { readonly configuration?: string };
      readonly indexing?: { readonly vectors: Hnsw | 'none' };
    },
  ) {
    super();
    const { name, description, key, loading, chunking, embedding } = options;
    const metadata = options.metadata ?? [];
    const configuration = options.keywords?.configuration ?? 'english';
    const build = options.indexing?.vectors ?? hnsw();
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
      options.from instanceof PostgresTable
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
    let files: readonly [] | readonly [ComputedDataset<string>, View] = [];
    let input: PostgresTable | View = options.from;
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
        sql: `SELECT ${columns.map((column) => `s.${quote(column)}`).join(', ')}, t."content" FROM ${source} AS s JOIN ${inWarehouse(rawTable(names.text))} AS t ON t."ref" = s.${quote(loading.file)} WHERE t."status" = 'computed'`,
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
      parts: rawParts,
      configuration,
    });
    // The source text of a passage is the key in the type of each key
    // column: jsonb_populate_record reads it into the row type of the source,
    // so the join compares in that type and looks the row up by its key.
    const keyOf = (column: string, value: string) =>
      `(jsonb_populate_record(NULL::${source}, jsonb_build_object(${literal(column)}, ${value}))).${quote(column)}`;
    const join =
      typeof key === 'string'
        ? `s.${quote(key)} = ${keyOf(key, 'p."source"')}`
        : columns
            .map(
              (column, index) =>
                `s.${quote(column)} = ${keyOf(column, `p."source"::jsonb -> ${index}`)}`,
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
        keywords: `The keywords of the text, the tsvector of the text search configuration ${configuration}.`,
        ...Object.fromEntries(
          metadata.map((column) => [
            column,
            `The ${column} column of the source row.`,
          ]),
        ),
      },
      sql: `SELECT k."id", p."source", p."seq", p."start", p."end", p."text", k."keywords"${metadata
        .map((column) => `, s.${quote(column)} AS ${quote(column)}`)
        .join(
          '',
        )} FROM ${inWarehouse(rawTable(names.keywords))} AS k JOIN ${parts} AS p ON p."source" = k."source" AND p."seq" = k."seq" JOIN ${source} AS s ON ${join}`,
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
      sql: `SELECT "part_hash" AS "id", "text" FROM ${parts}`,
    });
    const indexes: readonly PostgresIndex[] =
      build === 'none'
        ? []
        : [{ type: 'vector', column: 'vector', metric: 'cosine', build }];
    const chunkVectors = new ComputedDataset({
      into,
      name: names.chunkVectors,
      description: `The vector of each passage text of the vectorizer ${name}. ${description}`,
      from: [chunkTexts],
      compute: new Embedding({ ...embedding, key: 'id', fields: ['text'] }),
      indexes,
    });
    // A vector whose model failed is no answer to a search, so only computed
    // ones show. The rule names the model as the retriever reads it. The id
    // compares in byte order, as the primary key of the keyword index does,
    // so the retriever's join to the passages looks each one up by it.
    const passageVectors = new View({
      into,
      name: names.passageVectors,
      description: `The vector of each passage of the vectorizer ${name}, as @zukhruf/retrieval reads them. ${description}`,
      columns: {
        id: 'The id of the passage.',
        vector: 'The unit vector of the passage text.',
        model:
          'The model that made the vector: <provider>/<model id> (<n> dimensions).',
      },
      sql: `SELECT (p."source" || ':' || p."seq") COLLATE "C" AS "id", v."vector", v."rule" AS "model" FROM ${parts} AS p JOIN ${vectors} AS v ON v."id" = p."part_hash" WHERE v."status" = 'computed'`,
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
      sql: `WITH "members" ("dataset") AS (VALUES ${leaves
        .map((member) => `(${literal(member.qualifiedName)})`)
        .join(
          ', ',
        )}), "rows" AS (SELECT m."dataset", coalesce(d."state", 'waiting') AS "state", d."as_of", coalesce(d."pending", 0) AS "pending" FROM "members" AS m LEFT JOIN ${inWarehouse('derived_status')} AS d ON d."dataset" = m."dataset") SELECT CASE max(CASE "state" WHEN 'failed' THEN 3 WHEN 'waiting' THEN 2 WHEN 'refreshing' THEN 1 ELSE 0 END) WHEN 3 THEN 'failed' WHEN 2 THEN 'waiting' WHEN 1 THEN 'refreshing' ELSE 'current' END AS "state", CASE WHEN count("as_of") = count(*) THEN min("as_of") END AS "as_of", (SELECT "pending" FROM "rows" WHERE "dataset" = ${literal(chunks.qualifiedName)}) AS "pending_sources", (SELECT "pending" FROM "rows" WHERE "dataset" = ${literal(chunkVectors.qualifiedName)}) AS "pending_vectors" FROM "rows"`,
    });
    this.members = Object.freeze([...leaves, status]);
    this.contract = Object.freeze({
      schema: marts,
      passages: names.passages,
      vectors: names.passageVectors,
      index: Object.freeze({ column: 'keywords', configuration }),
    });
    Object.freeze(this);
  }

  // A source table must be one that a copy loads into the database of the
  // vectorizer, and the copy's stream must declare each column that the
  // vectorizer reads. A View's columns are its own SQL's, so its first
  // refresh tells, as for any view.
  override validate(connections: readonly Connection<PostgresTable>[]): void {
    const from = this.#from;
    if (!(from instanceof PostgresTable)) return;
    refuseUndeclaredColumns({
      vectorizer: this.name,
      from,
      copies: copiesInto(
        connections,
        (destination) =>
          destination instanceof PostgresDestination &&
          destination.url === this.into.url,
      ),
      destination: 'its database',
      key: this.#key,
      metadata: this.#metadata,
      loading: this.#loading,
    });
  }
}

// A string literal of SQL.
function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}
