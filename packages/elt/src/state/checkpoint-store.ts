import { isDeepStrictEqual } from 'node:util';

import type { FailureType } from '../core/source.ts';
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

// One keyed entry of a checkpoint: its key within its space, and its value as
// JSON text (ADR 0035).
export type CheckpointEntry = {
  readonly space: string;
  readonly key: string;
  readonly value: string;
};

// What a save does to a checkpoint's entries: update removes every entry
// whose space begins with one of the scopes in clear, then applies the
// removes and the puts to the saved entries; replace keeps only its puts, for
// a save whose read started from no checkpoint, which therefore read no
// entries. A scope is the start of the spaces of a partition, or the empty
// string for every space of the stream; the store knows no partition.
export type CheckpointEntryChanges =
  | {
      readonly kind: 'update';
      readonly clear: readonly string[];
      readonly put: readonly CheckpointEntry[];
      readonly remove: readonly Omit<CheckpointEntry, 'value'>[];
    }
  | { readonly kind: 'replace'; readonly put: readonly CheckpointEntry[] };

// A store reads a checkpoint's state and entries apart from the rest of it:
// they grow with the upstream, so the state is read only when the stream
// starts, and a space's entries only when a source asks for them.
export type CheckpointSession = {
  read(id: string): Promise<StoredCheckpoint | undefined>;
  // The saved state's JSON text, as save stored it.
  state(id: string): Promise<string | undefined>;
  // The saved entries of a space, as pairs of a key and its value's JSON
  // text; none for a checkpoint never saved.
  entries(
    id: string,
    space: string,
  ): Promise<Iterable<readonly [key: string, value: string]>>;
  // Durable when it resolves, the row and its entries in one transaction.
  // Stores the binding with the state, since a replication whose stream
  // changed shape saves the shape it loads.
  save(
    id: string,
    checkpoint: StoredCheckpoint & {
      readonly state: string;
      readonly entries: CheckpointEntryChanges;
    },
  ): Promise<void>;
  // Durable when it resolves: the reload the checkpoint was saved in
  // completed, so it keeps its state and is no longer reloading.
  reloaded(id: string): Promise<void>;
  // Removes the checkpoint with its entries.
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
  // The saved entries of a space, parsed for this call alone; none for a
  // replication never saved.
  entries(id: string, space: string): Promise<ReadonlyMap<string, unknown>>;
  // Whether the checkpoint was saved inside a reload that has not completed.
  reloading(id: string): boolean;
  // state is the JSON text of the state.
  save(
    id: string,
    state: string,
    entries: CheckpointEntryChanges,
    reloading: boolean,
  ): Promise<void>;
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
      return work({
        state: async (id) => {
          checkpoint(id);
          const state = await session.state(id);
          return state === undefined ? null : JSON.parse(state);
        },
        entries: async (id, space) => {
          checkpoint(id);
          const entries = new Map<string, unknown>();
          for (const [key, value] of await session.entries(id, space))
            entries.set(key, JSON.parse(value));
          return entries;
        },
        reloading: (id) => checkpoint(id).reloading,
        save: async (id, state, entries, reloading) => {
          const { binding } = checkpoint(id);
          await session.save(id, { binding, reloading, state, entries });
        },
        reloaded: async (id) => {
          checkpoint(id);
          await session.reloaded(id);
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

  // What kind of failure an error that this store raised is: what opening
  // the checkpoints of a run, or a read or save of them, threw. Only the store
  // knows which of its errors mean that a person must change the setup, such
  // as a login that may not create the table of the checkpoints.
  abstract failureType(error: unknown): FailureType;

  // Holds the replications' locks for the whole call, so one replication runs
  // at a time; each save is durable when it resolves.
  protected abstract session<T>(
    ids: readonly string[],
    work: (session: CheckpointSession) => Promise<T>,
  ): Promise<T>;
}
