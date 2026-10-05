import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { builtInConnectors } from './built-in-connectors.ts';
import { Connectors } from './connectors.ts';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));

test('every connector folder loads as its connector for the host, and one that cannot load is reported by its title while the rest still load', async () => {
  const { connectors, broken } = await new Connectors([
    builtInConnectors,
    fixtures,
    fileURLToPath(new URL('./missing/', import.meta.url)),
  ]).load({
    grantee: 'Terminal',
    eventKitHelper: fileURLToPath(
      new URL(
        'eventkit-helper',
        import.meta.resolve('@workspace/macos-eventkit'),
      ),
    ),
  });

  assert.deepEqual(connectors.map(({ name }) => name).sort(), [
    'activity',
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
  const photos = connectors.find(({ name }) => name === 'photos');
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
        title: 'Not a connector',
        error: `${fixtures}not-a-connector/not-a-connector-connector.js does not export an AppleConnector class by default.`,
      },
      { title: 'Notes again', error: 'Another connector is named notes.' },
    ],
  );
});
