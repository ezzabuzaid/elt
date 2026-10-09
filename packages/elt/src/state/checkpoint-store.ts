import { isDeepStrictEqual } from 'node:util';

import {
  StreamChangeError,
  changedDeclarations,
} from '../core/stream-change.ts';

// A replication's saved binding and state, as the JSON text a store keeps.
export type StoredCheckpoint = {
  readonly binding: string;
  readonly state: string;
};

export type CheckpointSession = {
  read(id: string): Promise<StoredCheckpoint | undefined>;
  // Durable when it resolves. Stores the binding with the state, since a
  // replication whose stream changed shape saves the shape it loads.
  save(id: string, checkpoint: StoredCheckpoint): Promise<void>;
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

// The checkpoints of one run's replications.
export type CheckpointRun = {
  // The saved state, or null for a replication never saved. Throws when the
  // replication's copy, or a declaration of its stream, changed since.
  state(id: string): unknown;
  // Whether the checkpoint was saved inside a reload that has not completed.
  reloading(id: string): boolean;
  save(id: string, state: unknown, reloading: boolean): Promise<void>;
};

// What a store keeps as a checkpoint's state: the source's own state, and
// whether it was saved inside a reload the destination has not swapped in.
type SavedState = { readonly state: unknown; readonly reloading: boolean };

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
          saved: SavedState;
          refused: Error | undefined;
        }
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
          saved:
            saved === undefined || refused !== undefined
              ? { state: null, reloading: false }
              : JSON.parse(saved.state),
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
      return work({
        // A source may mutate its input state, but only an acknowledged message may advance it.
        state: (id) => structuredClone(checkpoint(id).saved.state),
        reloading: (id) => checkpoint(id).saved.reloading,
        save: async (id, state, reloading) => {
          const { binding } = checkpoint(id);
          const saved: SavedState = { state, reloading };
          try {
            await session.save(id, { binding, state: JSON.stringify(saved) });
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
