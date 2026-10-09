import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { ProactiveStore } from './proactive-store.ts';

// ChatGPT asks the user before one chat creates or messages another and
// offers no way to approve that for good, so without Approve for me Meeting
// prep would wait on the user at every meeting. Codex runs the plugin's
// PermissionRequest hook before asking: it approves only the chats the
// Meeting prep gate handed over, called from the dispatcher chat it handed
// them to, and leaves every other call to the user.

// Codex's PermissionRequest hook output.
type ApprovalOutput = {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: { behavior: 'allow' };
  };
};

type ToolCall = {
  // The chat making the call.
  readonly threadId: string;
  readonly tool: string;
  readonly input: unknown;
};

const allow: ApprovalOutput = {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow' },
  },
};

// The prompt $meeting-prep gives each handed-over meeting's chat.
const briefPrompt =
  /^Brief .+ with \$meeting-prep, from its step 2\. Its step 1 row: (\{.*\})$/s;

const createThread = z.object({
  target: z.object({ type: z.literal('projectless') }),
  prompt: z.string(),
});
const sendMessage = z.object({ threadId: z.string() });
const meetingRow = z.object({ eventId: z.string() });

export function approveMeetingChat(
  call: ToolCall,
  directory: string,
): ApprovalOutput | undefined {
  if (!existsSync(join(directory, 'proactive.sqlite'))) return undefined;
  using store = new ProactiveStore(directory);
  const handed = store
    .meetings()
    .filter(({ dispatcherThreadId }) => dispatcherThreadId === call.threadId);
  switch (call.tool) {
    case 'mcp__codex_app__create_thread': {
      const eventId = briefedEventId(call.input);
      return handed.some(
        (meeting) =>
          meeting.eventId === eventId &&
          meeting.threadId === null &&
          !meeting.cancelled,
      )
        ? allow
        : undefined;
    }
    case 'mcp__codex_app__send_message_to_thread': {
      const message = sendMessage.safeParse(call.input);
      return message.success &&
        handed.some(({ threadId }) => threadId === message.data.threadId)
        ? allow
        : undefined;
    }
    default:
      return undefined;
  }
}

function briefedEventId(input: unknown): string | undefined {
  const thread = createThread.safeParse(input);
  const row = thread.success
    ? briefPrompt.exec(thread.data.prompt)?.[1]
    : undefined;
  if (row === undefined) return undefined;
  try {
    return meetingRow.safeParse(JSON.parse(row)).data?.eventId;
  } catch {
    return undefined;
  }
}
