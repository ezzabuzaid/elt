import { isDeepStrictEqual } from 'node:util';
import type {
  CheckpointRun,
  CheckpointStore,
} from '../state/checkpoint-store.ts';
import type { Copy, CopyOutcome, CopyProgress } from './copy.ts';
import type { Destination } from './destination.ts';
import { FileTransfer } from './file-transfer.ts';
import {
  type KeyValue,
  type ReadMessage,
  type Source,
  StreamStatus,
} from './source.ts';
import type { Stream } from './stream.ts';
import type { Target as DestinationTarget } from './target.ts';
import type { LoadFailure, Stage, WriteOperation } from './writer.ts';

// One copy's side of a replication: its stage, what it committed, what is
// pending since the last commit, and what did not load.
class Replicated<Target extends DestinationTarget> {
  stage: Stage | undefined;
  readonly emitted = { count: 0, deleted: 0 };
  readonly committed = { count: 0, deleted: 0 };
  readonly pending = { count: 0, deleted: 0 };
  readonly failures: LoadFailure[] = [];
  // Nothing commits after a failed read until the next checkpoint: a full
  // refresh has none, so any failure keeps the previous target.
  failed = false;
  // Nothing was applied since the last commit.
  clean = false;
  // The stage failed; the stream's remaining messages are ignored.
  broken = false;
  started = false;
  ended = false;
  resuming = false;
  settled = false;

  readonly files: FileTransfer;

  constructor(
    readonly copy: Copy<Target>,
    source: Source,
    destination: Destination<Target>,
    readonly observe: ((progress: CopyProgress<Target>) => void) | undefined,
  ) {
    this.files = new FileTransfer(
      copy.configuration.fileReads,
      destination.identity(copy.to),
      copy.writer(source),
    );
  }

  get stream(): Stream {
    return this.copy.from;
  }

  outcome(): CopyOutcome<Target> {
    return { copy: this.copy, ...this.committed, failures: this.failures };
  }

  report(): void {
    if (!this.settled) this.#notify('running');
  }

  settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.#notify(this.failures.length === 0 ? 'complete' : 'incomplete');
  }

  #notify(status: CopyProgress<Target>['status']): void {
    try {
      this.observe?.({
        copy: this.copy,
        status,
        emitted: { ...this.emitted },
        committed: { ...this.committed },
      });
    } catch {
      // Progress is advisory; see RecordedPass.progress.
    }
  }
}

// Airbyte's replication worker: one read covers every copy's stream, each
// stream's messages go to its own stage, and a checkpoint is saved only after
// its stage committed. A copy that fails does not stop the others.
export async function replicate<Target extends DestinationTarget>(
  source: Source,
  destination: Destination<Target>,
  checkpoints: CheckpointStore | undefined,
  copies: readonly Copy<Target>[],
  observe?: (progress: CopyProgress<Target>) => void,
): Promise<CopyOutcome<Target>[]> {
  const replications = copies.map(
    (copy) => new Replicated(copy, source, destination, observe),
  );
  const bindings = new Map<string, object>();
  for (const { copy } of replications)
    if (copy.configuration.syncMode === 'incremental' && copy.id !== undefined)
      bindings.set(copy.id, {
        source: source.identity,
        target: destination.identity(copy.to),
        configuration: copy.configuration,
      });
  try {
    if (checkpoints === undefined || bindings.size === 0)
      await transfer(source, destination, null, replications);
    else
      await checkpoints.run(bindings, (run) =>
        transfer(source, destination, run, replications),
      );
  } catch (error) {
    for (const replication of replications)
      if (!replication.ended) fail(replication, error);
  }
  // A broken stream the source never ended settles here, after the read.
  for (const replication of replications) replication.settle();
  return replications.map((replication) => replication.outcome());
}

async function transfer<Target extends DestinationTarget>(
  source: Source,
  destination: Destination<Target>,
  run: CheckpointRun | null,
  replications: readonly Replicated<Target>[],
): Promise<void> {
  const byStream = new Map(
    replications.map((replication) => [replication.stream.name, replication]),
  );
  const incremental = (replication: Replicated<Target>) =>
    replication.copy.configuration.syncMode === 'incremental';
  const checkpoint = (replication: Replicated<Target>) => {
    if (run === null || replication.copy.id === undefined)
      throw new TypeError(
        'Incremental copies require a stable id and checkpoint store',
      );
    return { run, id: replication.copy.id };
  };
  const states = new Map<string, unknown>();
  const reading: Replicated<Target>[] = [];
  for (const replication of replications) {
    if (!incremental(replication)) {
      reading.push(replication);
      continue;
    }
    try {
      const { run, id } = checkpoint(replication);
      const state = run.state(id);
      replication.resuming = state !== null;
      states.set(replication.stream.name, state);
      reading.push(replication);
    } catch (error) {
      fail(replication, error);
    }
  }
  if (reading.length === 0) return;
  await using load = await destination.load();
  // Every target is prepared before anything is read; a copy whose target is
  // refused reads nothing.
  const prepared: Replicated<Target>[] = [];
  for (const replication of reading)
    try {
      replication.stage = await load.prepare(
        replication.copy.configuration,
        replication.copy.to,
        {
          writer: replication.copy.writer(source),
          resuming: replication.resuming,
        },
      );
      await replication.files.reconcile(replication.stage.values);
      prepared.push(replication);
    } catch (error) {
      if (replication.stage !== undefined) await breakStage(replication, error);
      else fail(replication, error);
    }
  if (prepared.length === 0) return;
  try {
    for await (const message of source.read(
      prepared.map(({ copy }) => copy.configuration),
      states,
    )) {
      const replication = byStream.get(validStream(message));
      if (replication === undefined || !prepared.includes(replication))
        throw new TypeError(
          `Source emitted an unselected stream: ${message.stream}`,
        );
      if (replication.ended)
        throw new TypeError(`Source emitted ${message.stream} after it ended`);
      try {
        if (message instanceof StreamStatus) {
          if (message.status === 'STARTED') {
            if (replication.started)
              throw new TypeError(`Source started ${message.stream} twice`);
            replication.started = true;
            replication.report();
          } else if (message.status === 'FAILED') {
            if (replication.broken) continue;
            await started(replication).discard();
            replication.pending.count = 0;
            replication.pending.deleted = 0;
            replication.failed = true;
            replication.failures.push({
              partition: message.partition,
              error: message.error,
            });
            await replication.files.reconcile(started(replication).values);
            replication.report();
          } else {
            replication.ended = true;
            if (replication.broken) {
              replication.settle();
              continue;
            }
            const stage = started(replication);
            // The first commit also makes the prepared target itself durable,
            // so an empty overwrite still clears it.
            if (!replication.failed && !replication.clean)
              await commit(replication);
            replication.stage = undefined;
            await stage[Symbol.asyncDispose]();
            replication.settle();
          }
          continue;
        }
        if (replication.broken) continue;
        const operation = validOperation(replication.stream, message);
        if (operation.type === 'STATE') {
          if (!incremental(replication))
            throw new TypeError(
              `Full refresh stream ${message.stream} emitted a checkpoint`,
            );
          await commit(replication);
          const { run, id } = checkpoint(replication);
          await run.save(id, operation.state);
        } else {
          await started(replication).apply(
            operation.type === 'RECORD'
              ? {
                  ...operation,
                  data: await replication.files.record(operation.data),
                }
              : operation,
          );
          replication.clean = false;
          if (operation.type === 'RECORD') {
            replication.pending.count++;
            replication.emitted.count++;
          } else {
            replication.pending.deleted++;
            replication.emitted.deleted++;
          }
          replication.report();
        }
      } catch (error) {
        await breakStage(replication, error);
      }
    }
    for (const replication of prepared)
      if (!replication.ended && !replication.broken)
        await breakStage(
          replication,
          new TypeError(`Source did not end stream ${replication.stream.name}`),
        );
  } catch (error) {
    for (const replication of prepared)
      if (!replication.ended && !replication.broken)
        await breakStage(replication, error);
  }
}

function started<Target extends DestinationTarget>(
  replication: Replicated<Target>,
): Stage {
  if (!replication.started || replication.stage === undefined)
    throw new TypeError(
      `Source sent ${replication.stream.name} a message before starting it`,
    );
  return replication.stage;
}

async function commit<Target extends DestinationTarget>(
  replication: Replicated<Target>,
): Promise<void> {
  await started(replication).commit();
  replication.clean = true;
  replication.failed = false;
  replication.committed.count += replication.pending.count;
  replication.committed.deleted += replication.pending.deleted;
  replication.pending.count = 0;
  replication.pending.deleted = 0;
  await replication.files.reconcile(started(replication).values);
  replication.report();
}

function fail<Target extends DestinationTarget>(
  replication: Replicated<Target>,
  error: unknown,
): void {
  replication.failures.push({ partition: null, error });
  replication.broken = true;
  replication.ended = true;
  replication.settle();
}

// Fails a stream whose stage or checkpoint failed: its uncommitted rows are
// dropped with the stage, what it committed before stays, and its later
// messages are ignored until the source ends it.
async function breakStage<Target extends DestinationTarget>(
  replication: Replicated<Target>,
  error: unknown,
): Promise<void> {
  replication.failures.push({ partition: null, error });
  replication.broken = true;
  const { stage } = replication;
  replication.stage = undefined;
  try {
    await stage?.[Symbol.asyncDispose]();
  } catch (cause) {
    replication.failures.push({ partition: null, error: cause });
  }
}

function validStream(message: ReadMessage): string {
  if (
    message === null ||
    typeof message !== 'object' ||
    typeof message.stream !== 'string'
  )
    throw new TypeError(
      'Source must emit records with stream and data, DELETE or STATE messages',
    );
  return message.stream;
}

function validOperation(
  stream: Stream,
  message: ReadMessage,
): WriteOperation | { readonly type: 'STATE'; readonly state: unknown } {
  if (
    'type' in message &&
    message.type === 'STATE' &&
    Object.hasOwn(message, 'state') &&
    !Object.hasOwn(message, 'data')
  ) {
    const state: unknown = JSON.parse(JSON.stringify(message.state));
    if (!isDeepStrictEqual(state, message.state))
      throw new TypeError(
        'Checkpoint state must be losslessly JSON serializable',
      );
    wellFormed(state, 'Checkpoint state');
    return { type: 'STATE', state };
  }
  if (
    'type' in message &&
    message.type === 'DELETE' &&
    Object.hasOwn(message, 'key') &&
    !Object.hasOwn(message, 'data')
  )
    return { type: 'DELETE', key: deletionKey(stream, message.key) };
  if (
    !('type' in message) &&
    'data' in message &&
    Object.hasOwn(message, 'data')
  ) {
    if (Object.hasOwn(message, 'file'))
      throw new TypeError('Destinations cannot receive source staging paths');
    wellFormed(message.data, 'Record');
    return { type: 'RECORD', data: message.data };
  }
  throw new TypeError(
    'Source must emit records with stream and data, DELETE or STATE messages',
  );
}

// Every store keeps text as Unicode: a lone surrogate would load as U+FFFD
// (SQLite, Markdown) or be refused mid-load (Postgres), so no text reaches one.
function wellFormed(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (!value.isWellFormed())
      throw new TypeError(`${path} has a lone surrogate`);
  } else if (Array.isArray(value))
    for (const [index, item] of value.entries())
      wellFormed(item, `${path}[${index}]`);
  else if (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  )
    for (const [name, item] of Object.entries(value)) {
      if (!name.isWellFormed())
        throw new TypeError(`${path} has a field name with a lone surrogate`);
      wellFormed(item, `${path} field ${name}`);
    }
}

function deletionKey(
  stream: Stream,
  key: unknown,
): Readonly<Record<string, KeyValue>> {
  const { name, primaryKey, emitsDeletes } = stream;
  if (!emitsDeletes)
    throw new TypeError(`Stream ${name} does not emit deletions`);
  if (
    key === null ||
    typeof key !== 'object' ||
    Array.isArray(key) ||
    Object.getPrototypeOf(key) !== Object.prototype ||
    Object.keys(key).length !== primaryKey.length ||
    !primaryKey.every((field) => Object.hasOwn(key, field))
  )
    throw new TypeError(
      `DELETE for ${name} must carry exactly its primary key ${JSON.stringify(primaryKey)}`,
    );
  const snapshot: Record<string, KeyValue> = {};
  for (const field of primaryKey) {
    const value: unknown = Reflect.get(key, field);
    if (
      !(typeof value === 'string' && value.isWellFormed()) &&
      !(typeof value === 'number' && Number.isFinite(value)) &&
      typeof value !== 'boolean'
    )
      throw new TypeError(`DELETE for ${name} has an invalid ${field}`);
    snapshot[field] = value;
  }
  return Object.freeze(snapshot);
}
