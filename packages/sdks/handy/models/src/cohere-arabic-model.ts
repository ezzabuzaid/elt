import { HandyModel } from './handy-model.ts';

// Told the speech is Arabic, the model still writes English words and
// sentences as spoken, so one language covers mixed Arabic and English voice
// notes. Told English, it repeated a made-up sentence on a mixed note.
export class CohereArabicModel extends HandyModel {
  readonly id = 'cohere-transcribe-arabic-07-2026';
  protected readonly language = 'ar';
}
