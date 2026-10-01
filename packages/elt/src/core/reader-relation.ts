// A relation readers query, as every destination documents it: the meaning
// of the relation and of each output column. Destinations supply the SQL.
export type ReaderRelation = {
  readonly name: string;
  readonly description: string;
  readonly columns: Readonly<Record<string, string>>;
};

// Where readers discover every documented relation and column.
export const readerCatalog: ReaderRelation = Object.freeze({
  name: 'catalog',
  description:
    'One row per readable view, table and column, explaining meaning and use. Discover sync_status and extraction_coverage before judging freshness or completeness. Raw tables are not listed.',
  columns: Object.freeze({
    kind: 'view, table or column.',
    name: 'Relation name, or relation.column.',
    data_type: 'Column type; NULL for relations.',
    description:
      'Meaning, limitations and usage guidance; does not authorize refresh or other writes.',
  }),
});
