import type { SQLOutputValue } from 'node:sqlite';

// The tables an event row joins: the event (ZOBJECT), its metadata
// (ZSTRUCTUREDMETADATA) and its source (ZSOURCE).
export type KnowledgeTable = 'ZOBJECT' | 'ZSTRUCTUREDMETADATA' | 'ZSOURCE';

export type KnowledgeColumns = {
  readonly [T in KnowledgeTable]?: readonly string[];
};

export type KnowledgeRow = Readonly<Record<string, SQLOutputValue>>;

// One knowledgeC stream: its ZSTREAMNAME, how long macOS keeps its events,
// the columns its events carry beyond the common ones, and what they mean.
export abstract class KnowledgeStream<E> {
  abstract readonly name: string;
  // The stream's maximum age, compiled into macOS's BiomeLibrary.
  abstract readonly maximumAgeDays: number;
  abstract readonly columns: KnowledgeColumns;

  abstract decode(row: KnowledgeRow): E;
}
