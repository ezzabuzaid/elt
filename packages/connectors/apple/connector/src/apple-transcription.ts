import type { DocumentParser } from '@workspace/elt';
import { HandyModels } from '@workspace/sdk-handy-models';
import { Settings } from '@workspace/settings';
import { AudioFormat } from '@workspace/source-apple-macos/audio-format';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';
import {
  type LocalTranscriptionConfiguration,
  LocalTranscriptionModel,
} from '@workspace/transcription-local';

// The hosts share the user's saved choice. Each host owns its model process;
// refresh notices choices another CLI or plugin process saved in the same store.
export class AppleTranscription implements AsyncDisposable {
  readonly #settings: Settings;
  #closing = Promise.resolve();
  readonly #helper: string | undefined;
  #identity = 'null';
  #model: LocalTranscriptionModel | undefined;
  #parser: DocumentParser = new MacOSDocumentParser();

  constructor(directory: string, helper?: string) {
    this.#settings = new Settings(directory);
    this.#helper = helper;
  }

  get parser(): DocumentParser {
    this.#reload();
    return this.#parser;
  }

  async refresh(): Promise<void> {
    this.#reload();
    await this.#closing;
  }

  // A long-running CLI watch must see choices saved by another host too.
  // Each file takes one parser snapshot, so its identity and text agree even
  // when the model changes while another file is being read.
  #reload(): void {
    const model = this.#settings.transcription();
    const identity = JSON.stringify(model);
    if (identity === this.#identity) return;
    const previous = this.#model;
    this.#model =
      model === null
        ? undefined
        : new LocalTranscriptionModel(model, this.#helper);
    this.#parser = new MacOSDocumentParser(
      this.#model === undefined ? [] : [new AudioFormat(this.#model)],
    );
    this.#identity = identity;
    if (previous !== undefined)
      this.#closing = Promise.all([
        this.#closing,
        previous[Symbol.asyncDispose](),
      ]).then(() => undefined);
  }

  async configure(
    model: LocalTranscriptionConfiguration | null,
  ): Promise<void> {
    if (model !== null) {
      await using candidate = new LocalTranscriptionModel(model, this.#helper);
      await candidate.check();
    }
    this.#settings.setTranscription(model);
    await this.refresh();
  }

  async choices() {
    return {
      selected: this.#settings.transcription(),
      models: (await new HandyModels().list()).map(
        ({ id, title, configuration }) => ({ id, title, configuration }),
      ),
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await Promise.all([this.#closing, this.#model?.[Symbol.asyncDispose]()]);
    } finally {
      this.#settings[Symbol.dispose]();
    }
  }
}
