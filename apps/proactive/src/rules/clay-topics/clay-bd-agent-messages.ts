import { ClayTopicMessages } from './clay-topic-messages.ts';

export class ClayBdAgentMessages extends ClayTopicMessages {
  readonly name = 'Clay · BD agent';

  protected about(text: string, channelId: string): boolean {
    if (/\b(?:bd|business[ -]development)\s+agent\b/i.test(text)) return true;
    // These are the BD agent's controls and proposal workflow in the
    // Ezz/Mo/Clay work conversation, verified against Clay's feedback.
    return (
      channelId === 'C0BH287LC4R' &&
      /\b(?:team composition|relevant experience section|generate section|new proposal|rfp)\b/i.test(
        text,
      )
    );
  }
}
