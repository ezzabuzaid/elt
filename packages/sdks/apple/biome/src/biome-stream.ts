import type { ProtobufMessage } from '@workspace/codec-protobuf';

// One Biome stream: its folder under streams/restricted, how long macOS keeps
// its records, and what each record's protobuf fields mean.
export abstract class BiomeStream<E> {
  abstract readonly name: string;
  // The stream's maximum age, compiled into macOS's BiomeLibrary
  // (storeConfigurationFor<Stream> builds a BMPruningPolicy); no file on disk
  // states it.
  abstract readonly maximumAgeDays: number;

  abstract decode(message: ProtobufMessage): E;
}
