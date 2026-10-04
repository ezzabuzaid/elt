import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EventKitDocument, HelperRequest } from './documents.ts';

export type {
  EventKitDocument,
  HelperCalendarDocument,
  HelperRequest,
} from './documents.ts';

// One run of `eventkit read`: the documents it writes, then, with stderr, the
// failure it exits 1 with.
export type HelperRead = {
  readonly documents?: readonly EventKitDocument[];
  readonly stderr?: string;
};

// What `eventkit watch` writes. By default it confirms the subscription and
// then reports no change until it is stopped.
export type HelperWatch =
  | {
      readonly lines: readonly string[];
      readonly then: 'wait' | 'exit' | { readonly stderr: string };
    }
  // A store change every `everyMs` milliseconds.
  | { readonly everyMs: number }
  // One store change while the first read runs.
  | { readonly changeDuringFirstRead: true };

type Scenario = {
  readonly reads: readonly {
    readonly request: HelperRequest;
    readonly runs: readonly HelperRead[];
  }[];
  readonly watch: HelperWatch;
};

// A real executable that stands in for the eventkit helper where EventKit
// cannot produce the case: attendees, hand-written ICS, malformed documents,
// denied access, a missing ICS export, a failing watcher. A store runs it like
// the compiled helper, so its spawn, line parsing and error mapping run for
// real. A request it has no answer for fails, so what a store asks the helper
// for is part of every test.
export class StubEventKitHelper implements AsyncDisposable {
  readonly path: string;
  readonly #directory: AsyncDisposable & { readonly path: string };
  #scenario: Scenario = {
    reads: [],
    watch: { lines: ['changed'], then: 'wait' },
  };

  private constructor(directory: AsyncDisposable & { readonly path: string }) {
    this.#directory = directory;
    this.path = join(directory.path, 'eventkit-helper.mjs');
    writeFileSync(this.path, StubEventKitHelper.#script());
    chmodSync(this.path, 0o755);
    this.#save();
  }

  static async create(): Promise<StubEventKitHelper> {
    return new StubEventKitHelper(
      await mkdtempDisposable(join(tmpdir(), 'eventkit-stub-')),
    );
  }

  // Answers request with runs in order; once they are used up, the last one
  // answers again. A new answer for the same request replaces the old one.
  answer(request: HelperRequest, ...runs: readonly HelperRead[]): this {
    const key = StubEventKitHelper.#key(request);
    this.#scenario = {
      ...this.#scenario,
      reads: [
        ...this.#scenario.reads.filter(
          (read) => StubEventKitHelper.#key(read.request) !== key,
        ),
        { request, runs },
      ],
    };
    rmSync(this.#counter(request), { force: true });
    this.#save();
    return this;
  }

  watch(watch: HelperWatch): this {
    this.#scenario = { ...this.#scenario, watch };
    this.#save();
    return this;
  }

  // How many times the helper was asked for request.
  reads(request: HelperRequest): number {
    const counter = this.#counter(request);
    return existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#directory[Symbol.asyncDispose]();
  }

  #counter(request: HelperRequest): string {
    return join(
      this.#directory.path,
      `reads-${StubEventKitHelper.#key(request)}`,
    );
  }

  // The helper parses the request it receives, so keys ignore property order.
  static #key(request: HelperRequest): string {
    const sorted = Object.fromEntries(Object.entries(request).toSorted());
    return createHash('sha1').update(JSON.stringify(sorted)).digest('hex');
  }

  #save(): void {
    writeFileSync(
      join(this.#directory.path, 'scenario.json'),
      JSON.stringify(this.#scenario),
    );
  }

  // The helper's command line, answered from scenario.json beside it.
  static #script(): string {
    return `#!${process.execPath}
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

const here = (name) => new URL(name, import.meta.url);
const scenario = JSON.parse(readFileSync(here('scenario.json'), 'utf8'));
const [command, argument] = process.argv.slice(2);
const write = (line) => process.stdout.write(line + '\\n');
const fail = (stderr) => {
  process.stderr.write(stderr);
  process.exitCode = 1;
};
// Runs until the store stops it, as the real watcher does.
const stay = () => setInterval(() => {}, 1 << 30);
const key = (request) =>
  createHash('sha1')
    .update(JSON.stringify(Object.fromEntries(Object.entries(request).toSorted())))
    .digest('hex');

if (command === 'read') {
  writeFileSync(here('read-started'), '');
  const request = JSON.parse(argument);
  const index = scenario.reads.findIndex((read) =>
    isDeepStrictEqual(read.request, request),
  );
  if (index === -1) fail('The EventKit stub has no answer for ' + argument + '\\n');
  else {
    const counter = here('reads-' + key(request));
    const count = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
    writeFileSync(counter, String(count + 1));
    const { runs } = scenario.reads[index];
    const run = runs[Math.min(count, runs.length - 1)];
    for (const document of run.documents ?? []) write(JSON.stringify(document));
    if (run.stderr !== undefined) fail(run.stderr);
  }
} else if (command === 'watch') {
  const { watch } = scenario;
  if ('everyMs' in watch)
    for (;;) {
      write('changed');
      await sleep(watch.everyMs);
    }
  else if ('changeDuringFirstRead' in watch) {
    write('changed');
    while (!existsSync(here('read-started'))) await sleep(5);
    write('changed');
    stay();
  } else {
    for (const line of watch.lines) write(line);
    if (watch.then === 'wait') stay();
    else if (watch.then !== 'exit') fail(watch.then.stderr);
  }
} else fail('Usage: eventkit read <request> | eventkit watch events|reminders\\n');
`;
  }
}
