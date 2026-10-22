---
name: add-apple-monitor
description: Adds a monitor that watches the Apple imports and, after each sync, sends this chat an instruction when something new matches, such as "when I order food on Careem, log my calories". Use when the user asks to be told, or to have something done, when new data arrives in their Apple apps, or to fix a monitor the Apple page reports as failing.
---

# Add an Apple monitor

## What you need to know

- A monitor is a folder in `~/Library/Application Support/Context Compiler/Monitors/<name>/` holding two files: a `package.json` and the entry point it names.
- `package.json` is `{ "type": "module", "exports": "./<name>-monitor.ts", "contextCompiler": { "name": "<name>", "title": "<Title>", "description": "<what it watches, in the user's words>", "instruction": "<what to do when it matches>" } }`. `name` is lowercase letters, digits and dashes. The Apple page shows the title, the description and the instruction.
- The entry is TypeScript that Node runs as written. Its default export is an object with `async evaluate(sql)`. `sql` is a read-only handle with `all` and `get` tagged templates over every Apple import: name an import as a schema, by its connector name, as in `` sql.all`SELECT … FROM mail.messages` ``. A statement may name at most 10 imports.
- `evaluate` returns the matches that are true now: `[{ key, data }]`. The key names one thing across checks, such as a message id or an order id, and the turn uses it to find that thing. Each key is sent once while it keeps matching.
- After each sync, the plugin evaluates every added monitor. When a monitor has new keys, the plugin queues one message into the chat that added the monitor: the line `Monitor "<title>" triggered: <instruction>`, then `New matches:` and one `- <key>` line for each new key. That chat runs the message as a user turn. The message carries no other data: the turn finds the row of each key in the imports itself, as `$query-apple` describes.
- When you add a monitor, what it matches now is its baseline and is not sent. Only what starts to match later is sent.
- A monitor runs inside the plugin, with every macOS permission ChatGPT has.

## Writing the monitor

1. Ask the user for "when X, then Y" in their words, and confirm it with one example.
2. Find X in the imports as `$query-apple` describes. Read real rows, and pick a key that names one occurrence and finds its row, such as the message id of one receipt.
3. Write `package.json` and `<name>-monitor.ts` from this template. Keep the monitor in that one file.

   ```ts
   import type { Query } from '@zukhruf/sqlite-federation';

   // A new Careem delivery receipt in Mail.
   export default {
     async evaluate(sql: Query) {
       return sql.all`
         SELECT m.id FROM mail.messages m
         JOIN mail.addresses a ON a.id = m.sender
         JOIN mail.subjects s ON s.id = m.subject
         WHERE a.address = 'email@transactional.careem.com'
           AND s.subject LIKE 'Your Delivery%' AND m.deleted = 0`.map(
         (row) => ({
           key: String(row.id),
           data: null,
         }),
       );
     },
   };
   ```

   The instruction says what to do, not how: "Log my calorie intake from the food I ordered." The turn that runs it reads the receipts that the message names.

## Setting it up

1. Call `apple_monitor_add` with the monitor's `name` from this chat. It loads the monitor, takes its baseline and sends future matches to this chat. Read its error, fix the file, and call it again.
2. Tell the user that the monitor checks after each sync, that its instruction comes to this chat, and that the Apple page lists it under Monitors.

## Gotchas

- When the entry uses an `enum`, a `namespace` or a constructor parameter property, Node cannot run it as written and the monitor does not load. Use plain objects and functions.
- When the entry imports a module other than a Node built-in, it does not load. `import type` lines are erased and are allowed.
- When the key changes between checks for the same thing, such as a key built from the current time, the same thing is sent again at every sync. Build the key from the data.
- When the condition reads a preset, such as Mail's `mail_messages`, the check fails with `no such table`. Presets exist only for one `$query-apple` query; read the import's own views, which `catalog` lists.
- When one statement names more than 10 imports, the check fails. Split it into statements of 10 or fewer.
- When the chat that added a monitor is closed, its instruction waits until the user opens that chat. Add the monitor from a chat the user keeps.
- When a check throws, the Apple page shows `Last check failed: <error>`, and the monitor tries again at the next sync. Fix the file; you do not need to add it again.

## Done when

- `apple_monitor_add` succeeded from the chat that should receive the instruction.
- The Apple page lists the monitor as `Watching`, with no `Could not be loaded` or `Last check failed` line.
- You told the user what it watches, what it will do, and that it checks after each sync, which for a connector kept current is each change it loads.
