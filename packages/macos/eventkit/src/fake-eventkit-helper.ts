import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import type { EventKitDocument, HelperRequest } from './documents.ts';
import nativeProcess from './native-process.ts';

export type {
  EventKitDocument,
  HelperCalendarDocument,
  HelperRequest,
} from './documents.ts';

type Documents = () =>
  Iterable<EventKitDocument> | AsyncIterable<EventKitDocument>;
type Watch = (signal: AbortSignal) => AsyncIterable<string>;

// Stands in for the eventkit helper process, the one boundary EventKit tests
// cannot cross for real: EventKit cannot create attendees, a test cannot deny
// access or remove the ICS export, and a Mac's calendars can all sync to a
// server. A read request it answers yields its documents, one JSON line each;
// any other request throws, so what a store asks the helper for is part of
// every test.
export class FakeEventKitHelper {
  readonly #answers: (readonly [HelperRequest, Documents])[] = [];
  #watch: Watch = FakeEventKitHelper.#quiet;

  answer(request: HelperRequest, documents: Documents): this {
    this.#answers.push([request, documents]);
    return this;
  }

  // Replaces the watcher, which by default confirms its subscription and then
  // reports no change, so reads settle on their first attempt.
  watchWith(watch: Watch): this {
    this.#watch = watch;
    return this;
  }

  // Runs in place of the helper for the rest of the test.
  install(t: TestContext): this {
    t.mock.method(
      nativeProcess,
      'lines',
      (_file: string, args: readonly string[], signal?: AbortSignal) =>
        this.#run(args, signal),
    );
    return this;
  }

  async *#run(
    args: readonly string[],
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    if (args[0] === 'watch') {
      assert.ok(signal);
      yield* this.#watch(signal);
      return;
    }
    const request = JSON.parse(String(args[1]));
    const answer = this.#answers.find(([expected]) =>
      isDeepStrictEqual(request, expected),
    );
    if (answer === undefined)
      throw new Error(`The EventKit fake has no answer for ${args[1]}`);
    for await (const document of answer[1]()) yield JSON.stringify(document);
  }

  static async *#quiet(signal: AbortSignal): AsyncGenerator<string> {
    yield 'changed';
    if (!signal.aborted) await once(signal, 'abort');
  }
}
