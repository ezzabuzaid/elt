import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';

// A person at the Mac runs this suite (npx nx run sdk-apple-eventkit:test-prompt)
// and answers each prompt, either way. Each test launches an app that macOS
// has decided nothing for, so its read shows a real prompt; the terminal's own
// grants stay as they are.

const run = promisify(execFile);

const identifier = 'com.eltjs.eventkit.prompt';

// An app bundle whose main executable is a clone of this Node binary, signed
// ad hoc. LaunchServices opens it as its own client, so macOS asks for the
// app, not for the terminal. A copy of an Apple binary such as /bin/sleep
// does not run outside its path (launch constraints, macOS 13). Copied from
// @zukhruf/tcc's client.test.ts (docs/copied-test-helpers.md).
async function app(folder: string): Promise<void> {
  await mkdir(join(folder, 'Contents', 'MacOS'), { recursive: true });
  await copyFile(
    process.execPath,
    join(folder, 'Contents', 'MacOS', 'probe'),
    constants.COPYFILE_FICLONE,
  );
  await writeFile(
    join(folder, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>probe</string>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleName</key><string>EventKit Prompt</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
`,
  );
  // macOS records a grant against the app's code signature.
  await run('/usr/bin/codesign', ['--force', '--sign', '-', folder]);
}

// What the app runs: a store's short read, with the status of the store's
// service before and after it.
const probe = `
import { writeFileSync } from 'node:fs';

const [, , sdk, tcc, helper, entity, output] = process.argv;
const { CalendarStore, RemindersStore } = await import(sdk);
const { Calendars, Reminders } = await import(tcc);
const service = entity === 'events' ? new Calendars() : new Reminders();
const Store = entity === 'events' ? CalendarStore : RemindersStore;
const before = service.status();
let read = 'read';
try {
  await new Store(helper, { env: process.env }).collections({}, undefined);
} catch (error) {
  read = error.name;
}
writeFileSync(output, JSON.stringify({ before, read, after: service.status() }));
`;

for (const { entity, service, denied } of [
  {
    entity: 'events',
    service: 'Calendar',
    denied: 'CalendarUnavailableError',
  },
  {
    entity: 'reminders',
    service: 'Reminders',
    denied: 'RemindersUnavailableError',
  },
]) {
  test(
    `a read of ${entity} that macOS has decided nothing for asks through tcc and reads with the answer`,
    { timeout: 600_000 },
    async () => {
      // Arrange
      // LaunchServices finds no app in a temporary folder by its identifier,
      // and tccutil resets a grant through that lookup, so the app is built
      // under Caches.
      await using scratch = await new TemporaryFiles().directory(
        'eventkit-prompt-',
        { parent: join(homedir(), 'Library', 'Caches') },
      );
      const folder = await realpath(scratch.path);
      const bundle = join(folder, 'EventKit Prompt.app');
      await app(bundle);
      const script = join(folder, 'probe.mjs');
      await writeFile(script, probe);
      const output = join(folder, 'result.json');
      const log = join(folder, 'stderr.log');

      try {
        // Act
        await run('/usr/bin/open', [
          '-n',
          '-W',
          '--stderr',
          log,
          bundle,
          '--args',
          script,
          import.meta.resolve('@eltjs/sdk-apple-eventkit'),
          import.meta.resolve('@zukhruf/tcc'),
          fileURLToPath(
            import.meta.resolve('@eltjs/sdk-apple-eventkit/eventkit-helper'),
          ),
          entity,
          output,
        ]);

        // Assert
        const result = await readFile(output, 'utf8').catch(async () =>
          assert.fail(await readFile(log, 'utf8')),
        );
        const { before, read, after } = JSON.parse(result);
        assert.equal(before, 'notDetermined');
        assert.notEqual(after, 'notDetermined');
        assert.equal(read, after === 'fullAccess' ? 'read' : denied);
      } finally {
        await run('/usr/bin/tccutil', ['reset', service, identifier]);
      }
    },
  );
}
