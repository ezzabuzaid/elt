import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CodexCall {
  argv: string[];
  prompt: string;
}

// The real Codex service needs an authenticated, paid request. This
// executable stands in for the codex CLI with the contract that proactive
// uses: `codex exec` reads the prompt on stdin, fails when its --cd folder
// does not exist, and writes its last message to the --output-last-message
// path. execFile, stdin and the output file run for real.
export class CodexStandIn {
  readonly path: string;
  readonly #calls: string;

  private constructor(folder: string) {
    this.path = join(folder, 'codex');
    this.#calls = join(folder, 'codex-calls.jsonl');
  }

  // `reply` runs in the stand-in's own process from its source text, so it
  // can use only its argument and globals. A null reply makes the run fail.
  static async create(
    folder: string,
    reply: (prompt: string) => string | null,
  ): Promise<CodexStandIn> {
    const codex = new CodexStandIn(folder);
    await writeFile(codex.#calls, '');
    await writeFile(
      codex.path,
      `#!${process.execPath}
import { appendFile, stat, writeFile } from 'node:fs/promises';
const argv = process.argv.slice(2);
const option = (name) => argv[argv.indexOf(name) + 1];
if (argv.includes('--cd')) await stat(option('--cd'));
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
await appendFile(${JSON.stringify(codex.#calls)}, JSON.stringify({ argv, prompt }) + '\\n');
const reply = (${reply.toString()})(prompt);
if (reply === null) process.exit(1);
await writeFile(option('--output-last-message'), reply);
`,
      { mode: 0o700 },
    );
    return codex;
  }

  // Each run so far, in the order they started, failed runs included.
  async calls(): Promise<CodexCall[]> {
    return (await readFile(this.#calls, 'utf8'))
      .split('\n')
      .filter((line) => line !== '')
      .map((line): CodexCall => JSON.parse(line));
  }
}
