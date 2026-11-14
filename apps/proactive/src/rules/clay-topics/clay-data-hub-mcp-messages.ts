import { ClayTopicMessages } from './clay-topic-messages.ts';

export class ClayDataHubMcpMessages extends ClayTopicMessages {
  readonly name = 'Clay · Data Hub MCP';

  protected about(text: string, channelId: string): boolean {
    if (
      /\bdata[\s-]*hub\b/i.test(text) &&
      /\b(?:mcp|connector|plugin)\b/i.test(text)
    )
      return true;
    // In the shared work conversation, "the MCP" and these skills name
    // Data Hub. An arbitrary mention of another MCP is not enough.
    return (
      channelId === 'C0BH287LC4R' &&
      /\b(?:the mcp|mcp (?:version|discussion)|semantic layer|case[ -]study writer|colleague bio|bio skill|bd-relevant-experience-drafter)\b/i.test(
        text,
      )
    );
  }
}
