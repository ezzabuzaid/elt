import { isDeepStrictEqual } from 'node:util';

import type { Partition } from './partition.ts';

// What an open reload reloads: the whole stream, or some partitions of it,
// while the others load into the target as before, as Delta Lake's
// replaceWhere replaces only the rows that its condition selects.
export class WholeStream {}

export class SomePartitions {
  readonly partitions: readonly Partition[];

  constructor(partitions: readonly Partition[]) {
    this.partitions = Object.freeze([...partitions]);
  }

  // These partitions and partition, which a later RESET reloads too.
  with(partition: Partition): SomePartitions {
    return this.partitions.some((other) => isDeepStrictEqual(other, partition))
      ? this
      : new SomePartitions([...this.partitions, partition]);
  }
}

export type Reloads = WholeStream | SomePartitions;

export const wholeStream = new WholeStream();
