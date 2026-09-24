import { isDeepStrictEqual } from 'node:util';
import {
  CommittedWriteError,
  type WriteCount,
  type WriteResult,
} from '../core/writer.ts';

// A replication's saved binding and state, as the JSON text a store keeps.
export type StoredCheckpoint = {
  readonly binding: string;
  readonly state: string;
};

export type CheckpointSession = {
  read(): Promise<StoredCheckpoint | undefined>;
  // Saves state, keeping the binding a replication was first saved with.
  save(checkpoint: StoredCheckpoint): Promise<void>;
};

// Checkpoints belong to a replication ID, not to a shared Stream or warehouse
// table. The orchestrator keeps them, whatever the destination, and a store
// only supplies a locked session to keep them in.
export abstract class CheckpointStore {
  async run(
    id: string,
    binding: object,
    write: (state: unknown) => Promise<WriteResult>,
  ): Promise<WriteCount> {
    let committed: WriteCount | undefined;
    try {
      const serializedBinding = JSON.stringify(binding);
      return await this.session(id, async (session) => {
        const saved = await session.read();
        if (
          saved !== undefined &&
          !isDeepStrictEqual(
            JSON.parse(saved.binding),
            JSON.parse(serializedBinding),
          )
        )
          throw new TypeError(
            `Checkpoint binding changed for ${id}; reset it or use a new copy ID`,
          );
        const state: unknown =
          saved === undefined ? null : JSON.parse(saved.state);
        // A source may mutate its input state, but only an acknowledged message may advance it.
        const result = await write(structuredClone(state));
        committed = { count: result.count, deleted: result.deleted };
        const last = result.checkpoints.at(-1);
        await session.save({
          binding: serializedBinding,
          state: JSON.stringify(last === undefined ? state : last.state),
        });
        return committed;
      });
    } catch (cause) {
      if (committed !== undefined)
        throw new CommittedWriteError(
          committed,
          'Destination committed, but checkpoint persistence failed; retry may replay records',
          cause,
        );
      throw cause;
    }
  }

  abstract reset(id: string): Promise<void>;

  // Holds the replication's lock for the whole call; commits when work
  // resolves and rolls back when it rejects.
  protected abstract session<T>(
    id: string,
    work: (session: CheckpointSession) => Promise<T>,
  ): Promise<T>;
}
