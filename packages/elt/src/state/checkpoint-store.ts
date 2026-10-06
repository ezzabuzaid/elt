import { isDeepStrictEqual } from 'node:util';

// A replication's saved binding and state, as the JSON text a store keeps.
export type StoredCheckpoint = {
  readonly binding: string;
  readonly state: string;
};

export type CheckpointSession = {
  read(id: string): Promise<StoredCheckpoint | undefined>;
  // Durable when it resolves. Stores the binding with the state, since a
  // replication that started over saves the shape it started over for.
  save(id: string, checkpoint: StoredCheckpoint): Promise<void>;
  remove(id: string): Promise<void>;
};

// What a checkpoint belongs to: the copy (its source, target and selection),
// which must not change, and the shape of the stream it loads, whose change
// starts the replication over. A store keeps both as one JSON text.
export type CheckpointBinding = {
  readonly copy: object;
  readonly shape: object;
};

// The checkpoints of one run's replications.
export type CheckpointRun = {
  // The saved state, or null for a replication never saved or starting over.
  // Throws when the replication's copy changed since it was saved.
  state(id: string): unknown;
  // Whether the stream's shape changed since the checkpoint was saved.
  restart(id: string): boolean;
  save(id: string, state: unknown): Promise<void>;
};

// Checkpoints belong to a replication ID, not to a shared Stream or warehouse
// table. As Airbyte's platform keeps state apart from any destination, the
// orchestrator keeps them here, and saves each one the destination
// acknowledged, so a run that fails later resumes from its last commit.
export abstract class CheckpointStore {
  // Holds every replication's lock for the whole run.
  async run<T>(
    bindings: ReadonlyMap<string, CheckpointBinding>,
    work: (run: CheckpointRun) => Promise<T>,
  ): Promise<T> {
    const ids = [...bindings.keys()].sort();
    return this.session(ids, async (session) => {
      const checkpoints = new Map<
        string,
        {
          binding: string;
          state: unknown;
          changed: boolean;
          restart: boolean;
        }
      >();
      for (const [id, { copy, shape }] of bindings) {
        const binding = JSON.stringify([copy, shape]);
        const saved = await session.read(id);
        const [savedCopy, savedShape]: unknown[] =
          saved === undefined ? [] : JSON.parse(saved.binding);
        const [currentCopy, currentShape]: unknown[] = JSON.parse(binding);
        const changed =
          saved !== undefined && !isDeepStrictEqual(savedCopy, currentCopy);
        const restart =
          saved !== undefined &&
          !changed &&
          !isDeepStrictEqual(savedShape, currentShape);
        checkpoints.set(id, {
          binding,
          state:
            saved === undefined || changed || restart
              ? null
              : JSON.parse(saved.state),
          changed,
          restart,
        });
      }
      const checkpoint = (id: string) => {
        const found = checkpoints.get(id);
        if (found === undefined)
          throw new TypeError(`Checkpoint ${id} is not part of this run`);
        if (found.changed)
          throw new TypeError(
            `Checkpoint binding changed for ${id}; reset it or use a new copy ID`,
          );
        return found;
      };
      return work({
        // A source may mutate its input state, but only an acknowledged message may advance it.
        state: (id) => structuredClone(checkpoint(id).state),
        restart: (id) => checkpoint(id).restart,
        save: async (id, state) => {
          const { binding } = checkpoint(id);
          try {
            await session.save(id, { binding, state: JSON.stringify(state) });
          } catch (cause) {
            throw new Error(
              `Checkpoint ${id} was not saved after the destination committed; the next run replays from the last saved checkpoint`,
              { cause },
            );
          }
        },
      });
    });
  }

  // Forgets progress but keeps the loaded rows: the next run reloads
  // everything, as Airbyte's refresh that keeps records.
  async reset(id: string): Promise<void> {
    await this.session([id], (session) => session.remove(id));
  }

  // Airbyte's Clear: removes the data, then the checkpoint, under the
  // replication's lock. A crash between the two leaves a checkpoint beside an
  // emptied target, and clear can simply run again.
  async clear(id: string, drop: () => Promise<void>): Promise<void> {
    await this.session([id], async (session) => {
      await drop();
      await session.remove(id);
    });
  }

  // Holds the replications' locks for the whole call, so one replication runs
  // at a time; each save is durable when it resolves.
  protected abstract session<T>(
    ids: readonly string[],
    work: (session: CheckpointSession) => Promise<T>,
  ): Promise<T>;
}
