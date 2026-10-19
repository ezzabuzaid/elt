import { isDeepStrictEqual } from 'node:util';

import {
  StreamChangeError,
  changedDeclarations,
} from '../core/stream-change.ts';

// A replication's saved binding, as the JSON text a store keeps, and whether
// its state was saved inside a reload the destination has not swapped in.
export type StoredCheckpoint = {
  readonly binding: string;
  readonly reloading: boolean;
};

// A store reads a checkpoint's state apart from the rest of it: a snapshot's
// state grows with its upstream, so it is read only when its stream starts.
export type CheckpointSession = {
  read(id: string): Promise<StoredCheckpoint | undefined>;
  // The saved state's JSON text, as save stored it.
  state(id: string): Promise<string | undefined>;
  // Durable when it resolves. Stores the binding with the state, since a
  // replication whose stream changed shape saves the shape it loads.
  save(
    id: string,
    checkpoint: StoredCheckpoint & { readonly state: string },
  ): Promise<void>;
  // Durable when it resolves: the reload the checkpoint was saved in
  // completed, so it keeps its state and is no longer reloading.
  reloaded(id: string): Promise<void>;
  remove(id: string): Promise<void>;
};

// What a checkpoint belongs to: the copy (its source, its target's location
// and its selection), which must not change, and the shape of the stream it
// loads. A changed field keeps the checkpoint, as Airbyte keeps a connection's
// state through a non-breaking schema change, and the destination evolves its
// target, whether the target infers its columns or declares them; a
// changed declaration (see changedDeclarations) does not. A store keeps both
// as one JSON text.
export type CheckpointBinding = {
  readonly copy: object;
  readonly shape: object;
};

// The checkpoints of one run's replications. Each throws when the
// replication's copy, or a declaration of its stream, changed since.
export type CheckpointRun = {
  // The saved state, parsed for this call alone, so the caller owns it and
  // may change it; null for a replication never saved.
  state(id: string): Promise<unknown>;
  // Whether the checkpoint was saved inside a reload that has not completed.
  reloading(id: string): boolean;
  // state is the JSON text of the state.
  save(id: string, state: string, reloading: boolean): Promise<void>;
  // The reload the checkpoint was saved in completed.
  reloaded(id: string): Promise<void>;
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
        { binding: string; reloading: boolean; refused: Error | undefined }
      >();
      for (const [id, { copy, shape }] of bindings) {
        const binding = JSON.stringify([copy, shape]);
        const saved = await session.read(id);
        const [savedCopy, savedShape]: unknown[] =
          saved === undefined ? [] : JSON.parse(saved.binding);
        const [currentCopy, currentShape]: unknown[] = JSON.parse(binding);
        let refused: Error | undefined;
        if (saved !== undefined) {
          const declarations = changedDeclarations(savedShape, currentShape);
          if (!isDeepStrictEqual(savedCopy, currentCopy))
            refused = new TypeError(
              `Checkpoint binding changed for ${id}; reset it or use a new copy ID`,
            );
          else if (declarations.length > 0)
            refused = new StreamChangeError(id, declarations);
        }
        checkpoints.set(id, {
          binding,
          reloading: saved?.reloading ?? false,
          refused,
        });
      }
      const checkpoint = (id: string) => {
        const found = checkpoints.get(id);
        if (found === undefined)
          throw new TypeError(`Checkpoint ${id} is not part of this run`);
        if (found.refused !== undefined) throw found.refused;
        return found;
      };
      const durably = async (id: string, save: () => Promise<void>) => {
        try {
          await save();
        } catch (cause) {
          throw new Error(
            `Checkpoint ${id} was not saved after the destination committed; the next run replays from the last saved checkpoint`,
            { cause },
          );
        }
      };
      return work({
        state: async (id) => {
          checkpoint(id);
          const state = await session.state(id);
          return state === undefined ? null : JSON.parse(state);
        },
        reloading: (id) => checkpoint(id).reloading,
        save: (id, state, reloading) => {
          const { binding } = checkpoint(id);
          return durably(id, () =>
            session.save(id, { binding, reloading, state }),
          );
        },
        reloaded: (id) => {
          checkpoint(id);
          return durably(id, () => session.reloaded(id));
        },
      });
    });
  }

  // Forgets progress but keeps the loaded rows: the next run reloads
  // everything, as Airbyte's refresh that keeps records. It also accepts a
  // stream whose declarations changed, keeping its rows under them.
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
