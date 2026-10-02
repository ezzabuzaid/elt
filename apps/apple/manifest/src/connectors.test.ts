import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { builtInConnectors } from '@workspace/apple/apps/built-in-connectors';

import { Connectors } from './connectors.ts';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));

test('every connector folder loads as its app for the host, and one that cannot load is reported by its title while the rest still load', async () => {
  const { apps, broken } = await new Connectors([
    builtInConnectors,
    fixtures,
    fileURLToPath(new URL('./missing/', import.meta.url)),
  ]).load({ grantee: 'Terminal' });

  assert.deepEqual(apps.map(({ name }) => name).sort(), [
    'books',
    'calendar',
    'contacts',
    'mail',
    'messages',
    'notes',
    'photos',
    'reminders',
    'safari',
  ]);
  const photos = apps.find(({ name }) => name === 'photos');
  assert.equal(
    photos?.guidance(),
    'Turn on Terminal in System Settings › Privacy & Security › Full Disk Access, then quit and reopen Terminal. macOS does not ask for this access. Open Photos once.',
  );
  assert.deepEqual(
    broken.sort((a, b) => a.title.localeCompare(b.title)),
    [
      {
        title: 'Broken',
        error: 'The broken fixture fails while loading.',
      },
      {
        title: 'Not an app',
        error: `${fixtures}not-an-app/not-an-app-app.mjs does not export an AppleApp class by default.`,
      },
      { title: 'Notes again', error: 'Another connector is named notes.' },
    ],
  );
});
