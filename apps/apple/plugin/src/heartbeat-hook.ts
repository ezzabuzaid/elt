import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { appleDirectory } from './apple-directory.ts';
import { GardenGate } from './gates/garden-gate.ts';
import { MeetingPrepGate } from './gates/meeting-prep-gate.ts';

// The plugin's UserPromptSubmit command hook, started by hooks/heartbeat-gate
// only for a heartbeat that names one of the gates' skills. The gate whose
// skill the heartbeat names decides whether it reaches the model.

const { prompt } = z
  .object({ prompt: z.string() })
  .parse(JSON.parse(readFileSync(0, 'utf8')));
const instructions =
  /^<heartbeat>[\s\S]*?<instructions>([\s\S]*?)<\/instructions>/.exec(
    prompt,
  )?.[1];
if (instructions !== undefined) {
  const now = new Date();
  // This bundle sits in the server folder of the installed plugin.
  const skills = fileURLToPath(new URL('../skills', import.meta.url));
  for (const gate of [new MeetingPrepGate(skills), new GardenGate(skills)]) {
    const output = gate.answer(instructions, appleDirectory(), now);
    if (output !== undefined) {
      process.stdout.write(JSON.stringify(output));
      break;
    }
  }
}
