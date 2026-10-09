import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { appleDirectory } from './apple-directory.ts';
import { approveMeetingChat } from './meeting-chat-approval.ts';

// The plugin's PermissionRequest command hook, started by hooks/approval-gate
// for the codex_app tools hooks.json names. Printing nothing leaves the call
// to ChatGPT's own approval.

const call = z
  .object({
    session_id: z.string(),
    tool_name: z.string(),
    tool_input: z.unknown(),
  })
  .parse(JSON.parse(readFileSync(0, 'utf8')));
const output = approveMeetingChat(
  { threadId: call.session_id, tool: call.tool_name, input: call.tool_input },
  appleDirectory(),
);
if (output !== undefined) process.stdout.write(JSON.stringify(output));
