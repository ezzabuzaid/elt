import type { CheckpointStore } from '../state/checkpoint-store.ts';
import { Copy } from './copy.ts';
import type { Destination } from './destination.ts';
import type { Source } from './source.ts';
import type { Target as DestinationTarget } from './target.ts';

// Airbyte's connection: one source's copies into one destination, with the
// checkpoints that resume them. Its name is what readers of sync history see.
export class Connection<Target extends DestinationTarget> {
  readonly name: string;
  readonly source: Source;
  readonly destination: Destination<Target>;
  readonly checkpoints?: CheckpointStore;
  readonly steps: readonly Copy<Target>[];

  constructor({
    name,
    source,
    destination,
    steps,
    checkpoints,
  }: {
    name: string;
    source: Source;
    destination: Destination<Target>;
    steps: readonly Copy<NoInfer<Target>>[];
    checkpoints?: CheckpointStore;
  }) {
    if (!name.trim() || name.includes('\0'))
      throw new TypeError('A connection requires a name');
    if (!steps.every((step) => step instanceof Copy))
      throw new TypeError('Connection steps must be Copy declarations');
    this.name = name;
    this.source = source;
    this.destination = destination;
    this.checkpoints = checkpoints;
    this.steps = Object.freeze([...steps]);
    Object.freeze(this);
  }

  validate(): void {
    // One read routes messages and states by stream, as Airbyte's configured
    // catalog lists each stream once.
    const streams = this.steps.map((copy) => copy.from.name);
    if (new Set(streams).size !== streams.length)
      throw new TypeError(`Connection ${this.name} copies each stream once`);
    for (const copy of this.steps)
      copy.validate(this.source, this.destination, this.checkpoints);
  }
}
