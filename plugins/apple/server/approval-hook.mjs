import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  ProactiveStore,
  appleDirectory,
  external_exports
} from "./chunks/chunk-MBMOQFVV.mjs";
import {
  __callDispose,
  __using
} from "./chunks/chunk-ZGXE7NZW.mjs";

// apps/apple/plugin/src/approval-hook.ts
import { readFileSync } from "node:fs";

// apps/apple/plugin/src/meeting-chat-approval.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
var allow = {
  hookSpecificOutput: {
    hookEventName: "PermissionRequest",
    decision: { behavior: "allow" }
  }
};
var briefPrompt = /^Brief .+ with \$meeting-prep, from its step 2\. Its step 1 row: (\{.*\})$/s;
var createThread = external_exports.object({
  target: external_exports.object({ type: external_exports.literal("projectless") }),
  prompt: external_exports.string()
});
var sendMessage = external_exports.object({ threadId: external_exports.string() });
var meetingRow = external_exports.object({ eventId: external_exports.string() });
function approveMeetingChat(call2, directory) {
  var _stack = [];
  try {
    if (!existsSync(join(directory, "proactive.sqlite"))) return void 0;
    const store = __using(_stack, new ProactiveStore(directory));
    const handed = store.meetings().filter(({ dispatcherThreadId }) => dispatcherThreadId === call2.threadId);
    switch (call2.tool) {
      case "mcp__codex_app__create_thread": {
        const eventId = briefedEventId(call2.input);
        return handed.some(
          (meeting) => meeting.eventId === eventId && meeting.threadId === null && !meeting.cancelled
        ) ? allow : void 0;
      }
      case "mcp__codex_app__send_message_to_thread": {
        const message = sendMessage.safeParse(call2.input);
        return message.success && handed.some(({ threadId }) => threadId === message.data.threadId) ? allow : void 0;
      }
      default:
        return void 0;
    }
  } catch (_) {
    var _error = _, _hasError = true;
  } finally {
    __callDispose(_stack, _error, _hasError);
  }
}
function briefedEventId(input) {
  const thread = createThread.safeParse(input);
  const row = thread.success ? briefPrompt.exec(thread.data.prompt)?.[1] : void 0;
  if (row === void 0) return void 0;
  try {
    return meetingRow.safeParse(JSON.parse(row)).data?.eventId;
  } catch {
    return void 0;
  }
}

// apps/apple/plugin/src/approval-hook.ts
var call = external_exports.object({
  session_id: external_exports.string(),
  tool_name: external_exports.string(),
  tool_input: external_exports.unknown()
}).parse(JSON.parse(readFileSync(0, "utf8")));
var output = approveMeetingChat(
  { threadId: call.session_id, tool: call.tool_name, input: call.tool_input },
  appleDirectory()
);
if (output !== void 0) process.stdout.write(JSON.stringify(output));
