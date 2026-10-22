import type { DocumentParser } from '@workspace/elt';
import type { HandyModels } from '@workspace/sdk-handy-models';
import { Settings } from '@workspace/settings';
import { AudioFormat } from '@workspace/source-apple-macos/audio-format';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';
import { LocalTranscriptionModel } from '@workspace/transcription-local';

// The hosts share the user's saved choice: the id Handy installs a model
// under, whose files each host finds in its own Mac's Handy folder. Each host
// owns its model process; refresh notices choices another CLI or plugin
// process saved in the same store.
export class AppleTranscription implements AsyncDisposable {
  readonly #settings: Settings;
  readonly #models: HandyModels;
  #closing = Promise.resolve();
  readonly #helper: string | undefined;
  #chosen: string | null = null;
  #model: LocalTranscriptionModel | undefined;
  #parser: DocumentParser = new MacOSDocumentParser();

  constructor(directory: string, models: HandyModels, helper?: string) {
    this.#settings = new Settings(directory);
    this.#models = models;
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
  // when the model changes while another file is being read. A model Handy
  // does not know reads no audio, as when transcription is off.
  #reload(): void {
    const chosen = this.#settings.transcription();
    if (chosen === this.#chosen) return;
    const previous = this.#model;
    const configuration =
      chosen === null ? undefined : this.#models.find(chosen)?.configuration;
    this.#model =
      configuration === undefined
        ? undefined
        : new LocalTranscriptionModel(configuration, this.#helper);
    this.#parser = new MacOSDocumentParser(
      this.#model === undefined ? [] : [new AudioFormat(this.#model)],
    );
    this.#chosen = chosen;
    if (previous !== undefined)
      this.#closing = Promise.all([
        this.#closing,
        previous[Symbol.asyncDispose](),
      ]).then(() => undefined);
  }

  // Saves the model Handy installed under id, or null to stop transcribing.
  async configure(id: string | null): Promise<void> {
    if (id !== null) {
      const installed = await this.#models.list();
      const model = installed.find((candidate) => candidate.id === id);
      if (model === undefined)
        throw new Error(
          `No model ${id} is installed in Handy. Installed: ${installed.map((candidate) => candidate.id).join(', ') || 'none'}.`,
        );
      await using candidate = new LocalTranscriptionModel(
        model.configuration,
        this.#helper,
      );
      await candidate.check();
    }
    this.#settings.setTranscription(id);
    await this.refresh();
  }

  async choices() {
    return {
      selected: this.#settings.transcription(),
      models: (await this.#models.list()).map(({ id, title }) => ({
        id,
        title,
      })),
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
