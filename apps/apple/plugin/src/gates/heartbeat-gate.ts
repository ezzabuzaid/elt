import { join } from 'node:path';

// A heartbeat's gate, run by hooks/heartbeat-gate before the heartbeat
// reaches the model. ChatGPT wakes a chat on a schedule; the gate answers for
// the heartbeat whose instructions name its skill. With nothing due it blocks
// the heartbeat, so the model never runs and the chat shows nothing. With
// work due it lets the heartbeat run and hands that work over as context,
// one titled section per kind of work, each a JSON array the skill acts on.
// When it cannot tell what is due, it hands over why instead.

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
  // The installed plugin's skills. A chat that began before a plugin update
  // keeps the old skill paths, so the handover names the installed one.
  readonly #skills: string;

  constructor(skills: string) {
    this.#skills = skills;
  }

  // What is due now for this heartbeat, recorded as handed over.
  protected abstract due(directory: string, now: Date): Work;

  answer(
    instructions: string,
    directory: string,
    now: Date,
  ): GateOutput | undefined {
    if (!instructions.includes(`$${this.skill}`)) return undefined;
    const skill = `$${this.skill}, whose current instructions are at "${join(this.#skills, this.skill, 'SKILL.md')}"`;
    let work: Work;
    try {
      work = this.due(directory, now);
    } catch (error) {
      // A gate that exits with an error lets the heartbeat reach the model
      // with nothing in context, as when ChatGPT skips untrusted hooks; the
      // skill tells the two apart by this failure.
      return handover(
        `The Apple plugin's gate for ${skill} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if ('quiet' in work) return { decision: 'block', reason: work.quiet };
    return handover(
      [
        `The Apple plugin hands you this work for ${skill}. Each section is one kind of work; act on every item as those instructions describe.`,
        ...work.sections.map(
          ({ title, items }) => `${title}:\n${JSON.stringify(items)}`,
        ),
      ].join('\n\n'),
    );
  }
}

const handover = (additionalContext: string): GateOutput => ({
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext },
});
