import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ProtobufMessage } from '@workspace/codec-protobuf';
import { readSegb, segbFingerprint } from '@workspace/codec-segb';

import type { BiomeStream } from './biome-stream.ts';
import { BiomeUnavailableError } from './errors.ts';

// Bumped whenever a stream's decoding changes, so every segment fingerprints
// anew and a reader that skips unchanged segments reads them again.
const decodingVersion = 1;

// A record Biome still keeps, decoded. Biome never compacts a segment, so its
// origin, segment and slot identify it until it is deleted.
export type BiomeRecord<E> = {
  readonly slot: number;
  readonly writtenAt: Date;
  // The protobuf exactly as Biome stores it, with the fields decode leaves out.
  readonly payload: Uint8Array;
  readonly event: E;
};

// One segment file of a stream: 'local' for this Mac's, otherwise the
// identifier of the synced device it came from. The file is named for when
// the writing device started it, in microseconds since 2001-01-01.
export class BiomeSegment<E> {
  readonly origin: string;
  readonly name: string;
  readonly #path: string;
  readonly #stream: BiomeStream<E>;

  constructor(
    stream: BiomeStream<E>,
    origin: string,
    name: string,
    path: string,
  ) {
    this.#stream = stream;
    this.origin = origin;
    this.name = name;
    this.#path = path;
  }

  // Changes whenever Biome appends or deletes a record. Biome writes into a
  // preallocated file in place, so neither its size nor its modification time
  // does.
  async fingerprint(): Promise<string> {
    return `${decodingVersion}:${await segbFingerprint(this.#path)}`;
  }

  // The intact records, in slot order. Biome zero-fills a deleted record in
  // place and leaves some written slots zeroed; neither is a record.
  async records(): Promise<BiomeRecord<E>[]> {
    const records: BiomeRecord<E>[] = [];
    for (const { slot, writtenAt, payload } of await readSegb(this.#path)) {
      if (payload === null) continue;
      records.push({
        slot,
        writtenAt,
        payload,
        event: this.#stream.decode(new ProtobufMessage(payload)),
      });
    }
    return records;
  }
}

// Every segment of a stream: local/ holds this Mac's, remote/<device>/ each
// synced device's; tombstone/ folders beside them hold Biome's deletion log,
// not records. A stream Biome has not started yet has none.
export async function segments<E>(
  streams: string,
  stream: BiomeStream<E>,
): Promise<BiomeSegment<E>[]> {
  const files = async (origin: string, directory: string) =>
    (await entries(directory))
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map(
        (entry) =>
          new BiomeSegment(
            stream,
            origin,
            entry.name,
            join(directory, entry.name),
          ),
      );
  const folder = join(streams, stream.name);
  const devices = (await entries(join(folder, 'remote'))).filter((entry) =>
    entry.isDirectory(),
  );
  return [
    ...(await files('local', join(folder, 'local'))),
    ...(
      await Promise.all(
        devices.map((device) =>
          files(device.name, join(folder, 'remote', device.name)),
        ),
      )
    ).flat(),
  ];
}

async function entries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')
      return [];
    throw new BiomeUnavailableError(directory, cause);
  }
}
