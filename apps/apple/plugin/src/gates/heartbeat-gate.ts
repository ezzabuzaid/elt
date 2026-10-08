// A heartbeat's gate, run by hooks/heartbeat-gate before the heartbeat
// reaches the model. ChatGPT wakes a chat on a schedule; the gate answers for
// the heartbeat whose instructions name its skill. With nothing due it blocks
// the heartbeat, so the model never runs and the chat shows nothing. With
// work due it lets the heartbeat run and hands that work over as context,
// one titled section per kind of work, each a JSON array the skill acts on.

export type Work =
  { readonly quiet: string } | { readonly sections: readonly Section[] };

export type Section = {
  readonly title: string;
  readonly items: readonly object[];
};

// Codex's UserPromptSubmit hook output.
export type GateOutput =
  | { decision: 'block'; reason: string }
  | {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit';
        additionalContext: string;
      };
    };

export abstract class HeartbeatGate {
  // The skill the heartbeat's instructions name, without the $.
  protected abstract readonly skill: string;

  // What is due now for this heartbeat, recorded as handed over.
  protected abstract due(directory: string, now: Date): Work;

  answer(
    instructions: string,
    directory: string,
    now: Date,
  ): GateOutput | undefined {
    if (!instructions.includes(`$${this.skill}`)) return undefined;
    const work = this.due(directory, now);
    if ('quiet' in work) return { decision: 'block', reason: work.quiet };
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: [
          `The Apple plugin hands you this work for $${this.skill}. Each section is one kind of work; act on every item as $${this.skill} describes.`,
          ...work.sections.map(
            ({ title, items }) => `${title}:\n${JSON.stringify(items)}`,
          ),
        ].join('\n\n'),
      },
    };
  }
}
