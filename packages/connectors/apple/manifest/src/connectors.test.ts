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
        import.meta.resolve('@workspace/sdk-apple-eventkit'),
      ),
    ),
  });

  assert.deepEqual(connectors.map(({ name }) => name).sort(), [
    'accounts',
    'activity',
    'books',
    'calendar',
    'call-history',
    'contacts',
    'mail',
    'messages',
    'notes',
    'notification-center',
    'photos',
    'reminders',
    'safari',
    'slack',
  ]);
  const callHistory = connectors.find(({ name }) => name === 'call-history');
  assert.equal(
    callHistory?.guidance(),
    'Turn on Terminal in System Settings › Privacy & Security › Full Disk Access, then quit and reopen Terminal. macOS does not ask for this access. No app needs to be open: macOS keeps the calls from Phone, FaceTime and your iPhone in one store.',
  );
  const notificationCenter = connectors.find(
    ({ name }) => name === 'notification-center',
  );
  assert.equal(notificationCenter?.title, 'Notification Center');
  assert.equal(
    notificationCenter?.guidance(),
    'Turn on Terminal in System Settings › Privacy & Security › Full Disk Access, then quit and reopen Terminal. macOS does not ask for this access. No app needs to be open: macOS keeps every app’s notifications in one store while Notification Center holds them.',
  );
  const slack = connectors.find(({ name }) => name === 'slack');
  assert.equal(slack?.title, 'Slack');
  assert.equal(
    slack?.guidance(),
    'Turn on Terminal in System Settings › Privacy & Security › Full Disk Access, then quit and reopen Terminal. macOS does not ask for this access. Open Slack in each workspace to import and let it run: it saves what it has loaded every few minutes and when it quits, and only messages it has loaded on this Mac are imported.',
  );
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
