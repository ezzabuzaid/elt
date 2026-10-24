import {
  ClosedWorld,
  type SnapshotGroup,
} from '@zukhruf/snapshot-differential';

import {
  type CopyConfiguration,
  type Properties,
  type SchemaRecord,
  diffGroupedSnapshot,
} from '@workspace/elt';
import type { Message } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from './whatsapp-scan.ts';
import { WhatsAppStream } from './whatsapp-stream.ts';

// A message and its derived records share a small fingerprint. elt reuses
// unchanged groups and diffs changed ones, including keys that disappeared.
export abstract class WhatsAppMessageStream<
  P extends Properties,
  Row,
> extends WhatsAppStream<P, Row> {
  readonly store = 'chatStorage';

  override changes(
    configuration: CopyConfiguration,
    scan: WhatsAppScan,
    state: unknown,
    signal: AbortSignal | undefined,
  ): ReturnType<typeof diffGroupedSnapshot<SchemaRecord<P>>> {
    return diffGroupedSnapshot(
      configuration,
      this.#groups(
        scan,
        state === null || configuration.syncMode !== 'incremental',
      ),
      state,
      {
        policy: new ClosedWorld(),
        signal,
      },
    );
  }

  protected *rows(scan: WhatsAppScan): Generator<Row> {
    for (const message of scan.chatStorage.messages())
      yield* this.messageRows(message);
  }

  protected abstract messageRows(message: Message): Iterable<Row>;

  *#groups(
    scan: WhatsAppScan,
    readAll: boolean,
  ): Generator<SnapshotGroup<SchemaRecord<P>>> {
    // A first load needs every payload. Stream that join once instead of
    // issuing one point query per message; later passes fetch changed IDs.
    const messages = readAll ? scan.chatStorage.messages() : null;
    try {
      for (const input of scan.chatStorage.messageInputs()) {
        const message = messages?.next();
        if (message?.done)
          throw new Error('WhatsApp message inputs outlasted their snapshot');
        yield {
          key: String(input.id),
          fingerprint: input.fingerprint,
          records: () =>
            this.records(
              message === undefined
                ? scan.chatStorage
                    .messages(input.id)
                    .flatMap((row) => this.messageRows(row))
                : this.messageRows(message.value),
            ),
        };
      }
    } finally {
      messages?.return(undefined);
    }
  }
}
