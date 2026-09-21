import { Stream } from './stream.ts';

// Available streams and their logical schemas. A selection is another catalog.
export class Catalog {
  readonly streams: readonly Stream[];

  constructor(streams: Iterable<Stream>) {
    this.streams = Object.freeze(Array.from(streams));
    if (!this.streams.every((stream) => stream instanceof Stream))
      throw new TypeError('A catalog requires stream descriptions');
    if (
      new Set(this.streams.map((stream) => stream.name)).size !==
      this.streams.length
    )
      throw new TypeError('A catalog cannot contain duplicate stream names');
    Object.freeze(this);
  }

  get(name: string): Stream {
    const stream = this.streams.find((stream) => stream.name === name);
    if (!stream) throw new TypeError(`Unknown stream: ${name}`);
    return stream;
  }

  select(streams: Iterable<Stream>): Catalog {
    return new Catalog(Array.from(streams, (stream) => this.get(stream.name)));
  }
}
