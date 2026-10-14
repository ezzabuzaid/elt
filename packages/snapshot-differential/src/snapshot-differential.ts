import type {
  DeletionPolicy,
  KeyValue,
  VanishedRecord,
} from './deletion-policy.ts';
import { fingerprintOf } from './fingerprint.ts';
import {
  type GroupedSnapshotState,
  type SavedEntry,
  type SavedGroup,
  type SnapshotState,
  fingerprintIn,
  readGroups,
  readSnapshot,
  sorted,
} from './snapshot-state.ts';
import { isTimestamp } from './timestamp.ts';

export type SnapshotDifferentialOptions<Data> = {
  // Names the snapshot in errors.
  readonly name: string;
  readonly primaryKey: readonly string[];
  // The JSON array of a record's primary key values, in primaryKey order.
  readonly key: (record: Data) => string;
  // The field holding the timestamp at which the upstream drops a record,
  // kept with its key for the policy to read.
  readonly expiresBy?: string;
  readonly policy: DeletionPolicy;
};

// The records one input produced (a file, a message), keyed by that input,
// with a fingerprint the source computes without reading the input.
export type SnapshotGroup<Data> = {
  readonly key: string;
  // null when the source cannot vouch for the input: it is always read.
  readonly fingerprint: string | null;
  records(): AsyncIterable<Data> | Iterable<Data>;
};

export type SnapshotChange<Data, State> =
  | { readonly type: 'upsert'; readonly record: Data }
  | {
      readonly type: 'delete';
      readonly key: Readonly<Record<string, KeyValue>>;
    }
  | { readonly type: 'state'; readonly state: State };

// A snapshot differential (Labio and Garcia-Molina, VLDB 1996): change data
// capture for an upstream with no change log. It compares one complete scan
// with the previous snapshot and yields each new or changed record, a delete
// for each key the policy judges deleted, and the new snapshot last. An empty
// scan judges every key, so a failed read must throw, never yield nothing.
export class SnapshotDifferential<Data extends Record<string, unknown>> {
  readonly name: string;
  readonly primaryKey: readonly string[];
  readonly expiresBy?: string;
  readonly policy: DeletionPolicy;
  readonly #key: (record: Data) => string;

  constructor({
    name,
    primaryKey,
    key,
    expiresBy,
    policy,
  }: SnapshotDifferentialOptions<Data>) {
    this.name = name;
    this.primaryKey = primaryKey;
    this.#key = key;
    this.expiresBy = expiresBy;
    this.policy = policy;
  }

  // rereads names the lookback window: a scan the next one repeats only in
  // part, such as days an upstream may still restate. Only records the next
  // scan reads again stay in the snapshot; one left out is never deleted.
  async *diff(
    records: AsyncIterable<Data> | Iterable<Data>,
    state: unknown,
    { rereads }: { readonly rereads?: (record: Data) => boolean } = {},
  ): AsyncGenerator<SnapshotChange<Data, SnapshotState>> {
    const previous = readSnapshot(this.name, state);
    const seen = new Set<string>();
    const current = new Map<string, SavedEntry>();
    for await (const record of records) {
      const key = this.#claim(seen, record);
      const fingerprint = fingerprintOf(this.name, record);
      if (rereads?.(record) ?? true)
        current.set(key, this.#entry(record, fingerprint));
      if (fingerprintIn(previous.get(key)) !== fingerprint)
        yield { type: 'upsert', record };
    }
    yield* this.#judge(previous, seen, current);
    yield { type: 'state', state: { snapshot: sorted(current) } };
  }

  // diff for a scan whose records come from inputs the source fingerprints
  // cheaply. A group whose fingerprint matches the last committed scan keeps
  // its records without reading them; every other group is read and diffed
  // record by record. Vanished keys are judged over the complete scan.
  async *diffGroups(
    groups: AsyncIterable<SnapshotGroup<Data>> | Iterable<SnapshotGroup<Data>>,
    state: unknown,
  ): AsyncGenerator<SnapshotChange<Data, GroupedSnapshotState>> {
    const previous = readGroups(this.name, state);
    // Every saved entry by key, so a record that moves between groups or
    // comes back from unknown is compared with its previous fingerprint.
    const saved = new Map([
      ...[...previous.groups.values()].flatMap(({ snapshot }) =>
        Object.entries(snapshot),
      ),
      ...previous.unknown,
    ]);
    const seen = new Set<string>();
    const current = new Map<string, SavedGroup>();
    for await (const group of groups) {
      if (current.has(group.key))
        throw new TypeError(
          `Snapshot ${this.name} returned group ${group.key} twice in one scan`,
        );
      const before = previous.groups.get(group.key);
      if (
        group.fingerprint !== null &&
        before?.fingerprint === group.fingerprint
      ) {
        for (const key of Object.keys(before.snapshot))
          this.#claimKey(seen, key);
        current.set(group.key, before);
        continue;
      }
      const snapshot = new Map<string, SavedEntry>();
      for await (const record of group.records()) {
        const key = this.#claim(seen, record);
        const fingerprint = fingerprintOf(this.name, record);
        snapshot.set(key, this.#entry(record, fingerprint));
        if (fingerprintIn(saved.get(key)) !== fingerprint)
          yield { type: 'upsert', record };
      }
      current.set(group.key, {
        fingerprint: group.fingerprint,
        snapshot: sorted(snapshot),
      });
    }
    const unknown = new Map<string, SavedEntry>();
    yield* this.#judge(saved, seen, unknown);
    yield {
      type: 'state',
      state:
        unknown.size === 0
          ? { groups: sorted(current) }
          : { groups: sorted(current), unknown: sorted(unknown) },
    };
  }

  // Asks the policy about every saved key the scan did not list. A deleted
  // one yields a delete, an unknown one stays in kept, an expired one leaves.
  *#judge(
    saved: ReadonlyMap<string, SavedEntry>,
    seen: ReadonlySet<string>,
    kept: Map<string, SavedEntry>,
  ): Generator<SnapshotChange<Data, never>> {
    for (const [key, entry] of saved) {
      if (seen.has(key)) continue;
      const record: VanishedRecord =
        typeof entry === 'string'
          ? { key: this.#keyObject(key) }
          : { key: this.#keyObject(key), expiresBy: entry[1] };
      const verdict = this.policy.vanished(record);
      if (verdict === 'deleted') yield { type: 'delete', key: record.key };
      else if (verdict === 'unknown') kept.set(key, entry);
    }
  }

  #claim(seen: Set<string>, record: Data): string {
    const key = this.#key(record);
    this.#claimKey(seen, key);
    return key;
  }

  #claimKey(seen: Set<string>, key: string): void {
    if (seen.has(key))
      throw new TypeError(
        `Snapshot ${this.name} returned ${this.#keyText(key)} twice in one scan`,
      );
    seen.add(key);
  }

  #entry(record: Data, fingerprint: string): SavedEntry {
    if (this.expiresBy === undefined) return fingerprint;
    const expiresBy = record[this.expiresBy];
    if (!isTimestamp(expiresBy))
      throw new TypeError(
        `Snapshot ${this.name} records must carry ${this.expiresBy} as a timestamp to expire`,
      );
    return [fingerprint, expiresBy];
  }

  // A key as its primary key fields, from the JSON of its values.
  #keyObject(key: string): Record<string, KeyValue> {
    const values: KeyValue[] = JSON.parse(key);
    return Object.fromEntries(
      this.primaryKey.map((field, index) => {
        const value = values[index];
        if (value === undefined)
          throw new TypeError(
            `Snapshot key ${key} does not match ${this.name}'s primary key`,
          );
        return [field, value];
      }),
    );
  }

  // A key as people read it: each field with its value, a string as it is.
  #keyText(key: string): string {
    return Object.entries(this.#keyObject(key))
      .map(
        ([field, value]) =>
          `${field} ${typeof value === 'string' ? value : JSON.stringify(value)}`,
      )
      .join(', ');
  }
}
