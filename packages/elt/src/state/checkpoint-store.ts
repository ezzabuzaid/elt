import { isDeepStrictEqual } from 'node:util';

// A replication's saved binding and state, as the JSON text a store keeps.
export type StoredCheckpoint = {
  readonly binding: string;
  readonly state: string;
};

export type CheckpointSession = {
  read(): Promise<StoredCheckpoint | undefined>;
  // Durable when it resolves. Keeps the binding a replication was first saved with.
  save(checkpoint: StoredCheckpoint): Promise<void>;
  remove(): Promise<void>;
};

// Checkpoints belong to a replication ID, not to a shared Stream or warehouse
// table. As Airbyte's platform keeps state apart from any destination, the
// orchestrator keeps them here, and saves each one the destination
// acknowledged, so a run that fails later resumes from its last commit.
export abstract class CheckpointStore {
  async run<T>(
    id: string,
    binding: object,
    work: (
      state: unknown,
      save: (state: unknown) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    const serializedBinding = JSON.stringify(binding);
    return this.session(id, async (session) => {
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
      return work(structuredClone(state), async (next) => {
        try {
          await session.save({
            binding: serializedBinding,
            state: JSON.stringify(next),
          });
        } catch (cause) {
          throw new Error(
            `Checkpoint ${id} was not saved after the destination committed; the next run replays from the last saved checkpoint`,
            { cause },
          );
        }
      });
    });
  }

  // Forgets progress but keeps the loaded rows: the next run reloads
  // everything, as Airbyte's refresh that keeps records.
  async reset(id: string): Promise<void> {
    await this.session(id, (session) => session.remove());
  }

  // Airbyte's Clear: removes the data, then the checkpoint, under the
  // replication's lock. A crash between the two leaves a checkpoint beside an
  // emptied target, and clear can simply run again.
  async clear(id: string, drop: () => Promise<void>): Promise<void> {
    await this.session(id, async (session) => {
      await drop();
      await session.remove();
    });
  }

  // Holds the replication's lock for the whole call, so one replication runs
  // at a time; each save is durable when it resolves.
  protected abstract session<T>(
    id: string,
    work: (session: CheckpointSession) => Promise<T>,
  ): Promise<T>;
}
