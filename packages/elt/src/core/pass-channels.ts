import { channel } from 'node:diagnostics_channel';

import type { Connection } from './connection.ts';
import type { Copy, CopyOutcome } from './copy.ts';
import type { FailureType } from './source.ts';
import type { Target as DestinationTarget } from './target.ts';
import type { WriteCount } from './writer.ts';

// What each pass publishes while it runs, on node:diagnostics_channel
// channels, as Node asks a module to publish what it does
// (doc/api/diagnostics_channel.md) and as Got and undici publish their
// requests. A subscriber gets each message as unknown and tells it by its
// class. A subscriber that throws never stops the pass: Node reports the error
// as an uncaught exception. Messages carry no scope: a host that runs several
// passes tells its own by running them in an AsyncLocalStorage, as Node calls
// a subscriber in the async context of the publisher.
export const passChannels = {
  start: channel('elt:pass.start'),
  progress: channel('elt:copy.progress'),
  finish: channel('elt:pass.finish'),
  failure: channel('elt:pass.failure'),
};

/** A pass began: its sync history recorded the attempt. */
export class PassStarted {
  readonly connection: Connection<DestinationTarget>;
  constructor(connection: Connection<DestinationTarget>) {
    this.connection = connection;
  }
}

/**
 * One copy of a running pass so far, counted as Airbyte's sync stats tracker
 * counts a stream: what the source emitted and what the destination
 * committed. It ends once, complete or incomplete, as Airbyte's stream status
 * does.
 */
export class CopyProgress {
  readonly connection: Connection<DestinationTarget>;
  readonly copy: Copy<DestinationTarget>;
  readonly status: 'running' | 'complete' | 'incomplete';
  readonly emitted: WriteCount;
  readonly committed: WriteCount;
  constructor(
    connection: Connection<DestinationTarget>,
    copy: Copy<DestinationTarget>,
    status: 'running' | 'complete' | 'incomplete',
    emitted: WriteCount,
    committed: WriteCount,
  ) {
    this.connection = connection;
    this.copy = copy;
    this.status = status;
    this.emitted = emitted;
    this.committed = committed;
  }
}

/** A pass ended, once its sync history recorded each copy's outcome. */
export class PassFinished {
  readonly connection: Connection<DestinationTarget>;
  readonly outcomes: readonly CopyOutcome<DestinationTarget>[];
  constructor(
    connection: Connection<DestinationTarget>,
    outcomes: readonly CopyOutcome<DestinationTarget>[],
  ) {
    this.connection = connection;
    this.outcomes = outcomes;
  }
}

/**
 * A connection produced no pass, such as an invalid connection or a watcher
 * that stopped, once its sync history recorded why.
 */
export class PassFailed {
  readonly connection: Connection<DestinationTarget>;
  readonly error: unknown;
  readonly failureType: FailureType;
  constructor(
    connection: Connection<DestinationTarget>,
    error: unknown,
    failureType: FailureType,
  ) {
    this.connection = connection;
    this.error = error;
    this.failureType = failureType;
  }
}
