import { Copy, type Stream } from '@eltjs/elt';
import type { PostgresDestination } from '@eltjs/elt-postgresql';

export function martsCopy(destination: PostgresDestination, prefix: string) {
  return (stream: Stream) =>
    new Copy(
      stream,
      destination
        .table(`raw_${stream.name}`)
        .withReaderView(
          'marts',
          `${prefix}_${stream.name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
        ),
      {
        id: `${prefix}:${stream.name}`,
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
      },
    );
}
