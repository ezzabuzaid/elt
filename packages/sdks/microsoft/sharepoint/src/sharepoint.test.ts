import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { ChangeWatcher, type Outcome } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { Msw } from '@zukhruf/testing/msw';
import { type HttpHandler, http } from 'msw';

import {
  DeltaExpiredError,
  GraphError,
  SharePointAccessError,
  SharePointClient,
  SharePointCredentialsError,
  SharePointSiteNotFoundError,
  SiteVersion,
} from './index.ts';

const TENANT = '0b7f3f60-1f2c-4c5e-9d0a-6a1f2e3d4c5b';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SITE_URL = 'https://contoso.sharepoint.com/sites/Sales';
const SITE_ID =
  'contoso.sharepoint.com,5a58bb09-1fba-41c1-8125-69da264370a0,9f2ec1da-0be4-4a74-9254-973f0add78fd';

const sales = {
  id: SITE_ID,
  name: 'Sales',
  displayName: 'Sales',
  description: 'The sales team',
  webUrl: SITE_URL,
  createdDateTime: '2024-01-02T03:04:05Z',
  lastModifiedDateTime: '2026-11-16T08:00:00Z',
};

// The waits that a retry asks the clock for. Each wait ends at once, so a
// test reads the waits that were asked for instead of spending the time.
function fakeClock() {
  const waits: number[] = [];
  const clock = {
    setTimeout(callback: () => void, ms: number) {
      waits.push(ms);
      queueMicrotask(callback);
      return waits.length;
    },
    clearTimeout() {},
    performance: { now: () => 0 },
    Date: { now: () => Date.parse('2026-11-17T12:00:00Z') },
  };
  return { waits, clock };
}

/**
 * Microsoft's side of the wire for one test, stubbed below fetch with msw:
 * the token endpoint of Entra ID, which MSAL calls for the client
 * credentials, and Graph, whose every GET `graph` answers. `others` answer
 * other hosts. Any other request fails the test.
 */
function microsoft(
  graph: (url: URL) => Response,
  ...others: readonly HttpHandler[]
) {
  const { waits, clock } = fakeClock();
  const server = new Msw().intercept(
    http.post(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      () =>
        Response.json({
          token_type: 'Bearer',
          access_token: 'app-token',
          expires_in: 3599,
          ext_expires_in: 3599,
        }),
    ),
    http.get('https://graph.microsoft.com/*', ({ request }) =>
      graph(new URL(request.url)),
    ),
    ...others,
  );
  const graphRequests = () =>
    server.requests.filter(
      (request) => new URL(request.url).host === 'graph.microsoft.com',
    );
  return {
    waits,
    requests: server.requests,
    graphRequests,
    client: new SharePointClient({
      tenantId: TENANT,
      clientId: 'client-id',
      clientSecret: 'client-secret',
      clock,
    }),
    [Symbol.dispose]: () => server.cleanup(),
  };
}

// An error as Graph answers one.
function refusal(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
) {
  return Response.json(
    {
      error: {
        code,
        message,
        innerError: {
          date: '2026-11-17T12:00:00',
          'request-id': 'a2c4e6f8-0000-4000-8000-000000000001',
        },
      },
    },
    { status, headers },
  );
}

test('a Graph call carries the bearer token that the client credentials of the app get', async (t) => {
  using microsoftSide = microsoft(() => Response.json(sales));

  const site = await microsoftSide.client.site(SITE_URL, t.signal);

  assert.deepEqual(site, sales);
  const token = microsoftSide.requests.find((request) =>
    request.url.startsWith('https://login.microsoftonline.com/'),
  );
  assert.ok(token !== undefined);
  const form = new URLSearchParams(await token.text());
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_id'), 'client-id');
  assert.equal(form.get('client_secret'), 'client-secret');
  assert.equal(form.get('scope'), 'https://graph.microsoft.com/.default');
  const [call] = microsoftSide.graphRequests();
  assert.ok(call !== undefined);
  assert.equal(call.headers.get('authorization'), 'Bearer app-token');
  assert.equal(
    new URL(call.url).pathname,
    '/v1.0/sites/contoso.sharepoint.com:/sites/Sales',
  );
});

test('the site, its drives, lists, columns, pages and text web parts come back as Graph gives them', async (t) => {
  const LIST_ID = 'b1c2d3e4-0000-4000-8000-00000000000a';
  const PAGE_ID = 'f7a9c0d1-0000-4000-8000-00000000000b';
  const documentsDrive = {
    id: 'b!CbtYWrofwUGBJWnaJkNwoNrBLp_kC3RKklSXPwrdeP0',
    name: 'Documents',
    description: '',
    driveType: 'documentLibrary',
    webUrl: `${SITE_URL}/Shared%20Documents`,
    createdDateTime: '2024-01-02T03:04:05Z',
    lastModifiedDateTime: '2026-11-16T08:00:00Z',
  };
  const documentsList = {
    id: LIST_ID,
    name: 'Shared Documents',
    displayName: 'Documents',
    description: '',
    webUrl: `${SITE_URL}/Shared%20Documents`,
    createdDateTime: '2024-01-02T03:04:05Z',
    lastModifiedDateTime: '2026-11-16T08:00:00Z',
    list: {
      contentTypesEnabled: false,
      hidden: false,
      template: 'documentLibrary',
    },
  };
  const accessRequests = {
    id: 'c2d3e4f5-0000-4000-8000-00000000000c',
    name: 'Access Requests',
    displayName: 'Access Requests',
    webUrl: `${SITE_URL}/Access%20Requests`,
    createdDateTime: '2024-01-02T03:04:05Z',
    lastModifiedDateTime: '2026-11-01T08:00:00Z',
    list: {
      contentTypesEnabled: true,
      hidden: true,
      template: 'accessRequest',
    },
  };
  const common = {
    columnGroup: 'Custom Columns',
    description: '',
    enforceUniqueValues: false,
    hidden: false,
    indexed: false,
    readOnly: false,
  };
  const title = {
    ...common,
    id: 'fa564e0f-0c70-4ab9-b863-0177e6ddd247',
    name: 'Title',
    displayName: 'Title',
    required: true,
    text: {
      allowMultipleLines: false,
      appendChangesToExistingText: false,
      linesForEditing: 0,
      maxLength: 255,
    },
  };
  const status = {
    ...common,
    id: '3a6b296c-0000-4000-8000-00000000000d',
    name: 'Status',
    displayName: 'Status',
    required: false,
    choice: {
      allowTextEntry: false,
      choices: ['Draft', 'Final'],
      displayAs: 'dropDownMenu',
    },
  };
  // A column of a type that Graph does not model, such as a managed
  // metadata column on an older site, has no facet.
  const taxonomy = {
    ...common,
    id: '4b7c3a7d-0000-4000-8000-00000000000e',
    name: 'TaxCatchAll',
    displayName: 'Taxonomy Catch All Column',
    required: false,
  };
  const home = {
    '@odata.type': '#microsoft.graph.sitePage',
    '@odata.etag': '"{F7A9C0D1-0000-4000-8000-00000000000B},3"',
    eTag: '"{F7A9C0D1-0000-4000-8000-00000000000B},3"',
    id: PAGE_ID,
    name: 'Home.aspx',
    title: 'Home',
    description: 'Welcome to the sales site',
    webUrl: 'SitePages/Home.aspx',
    pageLayout: 'home',
    createdDateTime: '2024-01-02T03:04:05Z',
    lastModifiedDateTime: '2026-11-10T08:00:00Z',
    createdBy: {
      user: { displayName: 'Rana Haddad', email: 'rana@contoso.com' },
    },
    lastModifiedBy: {
      user: { displayName: 'Rana Haddad', email: 'rana@contoso.com' },
    },
    parentReference: { siteId: '5a58bb09-1fba-41c1-8125-69da264370a0' },
    contentType: {
      id: '0x0101009D1CB255DA76424F860D91F20E6C4118',
      name: 'Site Page',
    },
    publishingState: { level: 'published', versionId: '3.0' },
  };
  const welcome = {
    '@odata.type': '#microsoft.graph.textWebPart',
    id: '6f9230af-2a98-4952-b205-9ede4f9ef548',
    innerHtml: '<p>Welcome to the <strong>sales</strong> site.</p>',
  };
  const contacts = {
    '@odata.type': '#microsoft.graph.textWebPart',
    id: '7a8b9c0d-0000-4000-8000-00000000000f',
    innerHtml: '<p>Ask Rana for the price list.</p>',
  };
  const image = {
    '@odata.type': '#microsoft.graph.standardWebPart',
    id: '8b9c0d1e-0000-4000-8000-000000000010',
    webPartType: 'd1d91016-032f-456d-98a4-721247c305e8',
    data: {
      dataVersion: '1.9',
      description: 'Show an image on your page',
      title: 'Image',
      properties: { imageSourceType: 2, altText: 'The team' },
    },
  };
  const canvas = {
    ...home,
    canvasLayout: {
      horizontalSections: [
        {
          layout: 'twoColumns',
          id: '1',
          emphasis: 'none',
          columns: [
            { id: '1', width: 6, webparts: [welcome] },
            { id: '2', width: 6, webparts: [image] },
          ],
        },
      ],
      verticalSection: { emphasis: 'none', webparts: [contacts] },
    },
  };
  using microsoftSide = microsoft((url) => {
    const site = `/v1.0/sites/${SITE_ID}`;
    switch (url.pathname) {
      case '/v1.0/sites/contoso.sharepoint.com:/sites/Sales':
        return Response.json({
          '@odata.context':
            'https://graph.microsoft.com/v1.0/$metadata#sites(id,name,displayName,description,webUrl,createdDateTime,lastModifiedDateTime)/$entity',
          ...sales,
        });
      case `${site}/drives`:
        return Response.json({ value: [documentsDrive] });
      case `${site}/lists`:
        return Response.json({
          value: [
            { '@odata.etag': '"b1c2d3e4,12"', ...documentsList },
            { '@odata.etag': '"c2d3e4f5,3"', ...accessRequests },
          ],
        });
      case `${site}/lists/${LIST_ID}/columns`:
        return Response.json({ value: [title, status, taxonomy] });
      case `${site}/pages`:
        return Response.json({ value: [home] });
      case `${site}/pages/${PAGE_ID}/microsoft.graph.sitePage`:
        return url.searchParams.get('$expand') === 'canvasLayout'
          ? Response.json(canvas)
          : refusal(400, 'invalidRequest', 'The canvas was not expanded');
      default:
        return refusal(404, 'itemNotFound', 'Not found');
    }
  });
  const { client } = microsoftSide;
  const signal = t.signal;

  const site = await client.site(SITE_URL, signal);
  const drives = await client.drives(site.id, signal);
  const lists = await client.lists(site.id, signal);
  const columns = await client.columns(site.id, LIST_ID, signal);
  const pages = await client.pages(site.id, signal);
  const parts = await client.textWebParts(site.id, PAGE_ID, signal);

  assert.deepEqual(site, sales);
  assert.deepEqual(drives, [documentsDrive]);
  assert.deepEqual(lists, [documentsList, accessRequests]);
  const { text, ...titleFields } = title;
  const { choice, ...statusFields } = status;
  assert.deepEqual(columns, [
    { ...titleFields, type: { name: 'text', settings: text } },
    { ...statusFields, type: { name: 'choice', settings: choice } },
    { ...taxonomy, type: null },
  ]);
  assert.deepEqual(pages, [
    {
      id: home.id,
      name: home.name,
      title: home.title,
      description: home.description,
      webUrl: home.webUrl,
      pageLayout: home.pageLayout,
      eTag: home.eTag,
      createdDateTime: home.createdDateTime,
      lastModifiedDateTime: home.lastModifiedDateTime,
      createdBy: home.createdBy,
      lastModifiedBy: home.lastModifiedBy,
      publishingState: home.publishingState,
    },
  ]);
  assert.deepEqual(parts, [
    { id: welcome.id, innerHtml: welcome.innerHtml },
    { id: contacts.id, innerHtml: contacts.innerHtml },
  ]);
});

test('a client secret that Entra ID refuses fails with a SharePointCredentialsError, and no Graph request is sent', async (t) => {
  const { clock } = fakeClock();
  using server = new Msw().intercept(
    http.post(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      () =>
        Response.json(
          {
            error: 'invalid_client',
            error_description:
              "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app 'client-id'.",
            error_codes: [7000215],
          },
          { status: 401 },
        ),
    ),
  );
  const client = new SharePointClient({
    tenantId: TENANT,
    clientId: 'client-id',
    clientSecret: 'wrong-secret',
    clock,
  });

  await assert.rejects(
    client.site(SITE_URL, t.signal),
    SharePointCredentialsError,
  );
  assert.deepEqual(
    server.requests.filter(
      (request) => new URL(request.url).host === 'graph.microsoft.com',
    ),
    [],
  );
});

test('a 429 waits the Retry-After on the clock, then the request is sent again', async (t) => {
  let served = 0;
  using microsoftSide = microsoft(() =>
    served++ === 0
      ? refusal(429, 'TooManyRequests', 'Too many requests', {
          'retry-after': '7',
        })
      : Response.json(sales),
  );

  const site = await microsoftSide.client.site(SITE_URL, t.signal);

  assert.deepEqual(site, sales);
  assert.deepEqual(microsoftSide.waits, [7000]);
  assert.equal(microsoftSide.graphRequests().length, 2);
});

for (const [status, code] of [
  [503, 'serviceNotAvailable'],
  [504, 'gatewayTimeout'],
] as const) {
  test(`a ${status} waits on the clock, then the request is sent again`, async (t) => {
    let served = 0;
    using microsoftSide = microsoft(() =>
      served++ === 0
        ? refusal(status, code, 'The service is busy')
        : Response.json(sales),
    );

    const site = await microsoftSide.client.site(SITE_URL, t.signal);

    assert.deepEqual(site, sales);
    assert.equal(microsoftSide.graphRequests().length, 2);
    // No Retry-After: the first wait is a full jitter of 1 s.
    assert.equal(microsoftSide.waits.length, 1);
    const [wait] = microsoftSide.waits;
    assert.ok(wait !== undefined && wait >= 0 && wait <= 1000, `${wait}`);
  });
}

test('a request that Graph answers 429 every time fails with a GraphError after five tries', async (t) => {
  using microsoftSide = microsoft(() =>
    refusal(429, 'TooManyRequests', 'Too many requests', {
      'retry-after': '1',
    }),
  );

  await assert.rejects(
    microsoftSide.client.site(SITE_URL, t.signal),
    (error: unknown) => {
      assert.ok(error instanceof GraphError);
      assert.equal(error.status, 429);
      assert.equal(error.code, 'TooManyRequests');
      return true;
    },
  );
  assert.equal(microsoftSide.graphRequests().length, 5);
  assert.deepEqual(microsoftSide.waits, [1000, 1000, 1000, 1000]);
});

test('a Retry-After of more than 60 seconds fails at once, with no wait', async (t) => {
  using microsoftSide = microsoft(() =>
    refusal(429, 'TooManyRequests', 'Too many requests', {
      'retry-after': '61',
    }),
  );

  await assert.rejects(
    microsoftSide.client.site(SITE_URL, t.signal),
    (error: unknown) => {
      assert.ok(error instanceof GraphError);
      assert.equal(error.status, 429);
      return true;
    },
  );
  assert.equal(microsoftSide.graphRequests().length, 1);
  assert.deepEqual(microsoftSide.waits, []);
});

test('a Retry-After given as an HTTP date waits until that date on the clock', async (t) => {
  let served = 0;
  // The fake clock's Date.now is 2026-11-17T12:00:00Z.
  using microsoftSide = microsoft(() =>
    served++ === 0
      ? refusal(503, 'serviceNotAvailable', 'The service is busy', {
          'retry-after': 'Tue, 17 Nov 2026 12:00:30 GMT',
        })
      : Response.json(sales),
  );

  const site = await microsoftSide.client.site(SITE_URL, t.signal);

  assert.deepEqual(site, sales);
  assert.deepEqual(microsoftSide.waits, [30_000]);
  assert.equal(microsoftSide.graphRequests().length, 2);
});

test('a site that the app holds no grant on fails with a SharePointAccessError that names the site URL', async (t) => {
  using microsoftSide = microsoft(() =>
    refusal(403, 'accessDenied', 'Access denied'),
  );

  await assert.rejects(
    microsoftSide.client.site(SITE_URL, t.signal),
    (error: unknown) => {
      assert.ok(error instanceof SharePointAccessError);
      assert.equal(error.resource, SITE_URL);
      assert.match(
        error.message,
        /https:\/\/contoso\.sharepoint\.com\/sites\/Sales/,
      );
      assert.match(
        error.message,
        /The app needs a Sites\.Selected read grant on the site\./,
      );
      assert.ok(error.cause instanceof GraphError);
      assert.equal(error.cause.status, 403);
      assert.equal(error.cause.code, 'accessDenied');
      return true;
    },
  );
});

test('a token that Graph refuses fails with a SharePointAccessError too', async (t) => {
  using microsoftSide = microsoft(() =>
    refusal(401, 'InvalidAuthenticationToken', 'Access token is empty.'),
  );

  await assert.rejects(
    microsoftSide.client.site(SITE_URL, t.signal),
    (error: unknown) => {
      assert.ok(error instanceof SharePointAccessError);
      assert.equal(error.resource, SITE_URL);
      assert.match(
        error.message,
        /The app needs a Sites\.Selected read grant on the site\./,
      );
      assert.ok(error.cause instanceof GraphError);
      assert.equal(error.cause.status, 401);
      assert.equal(error.cause.code, 'InvalidAuthenticationToken');
      return true;
    },
  );
});

test('a site URL that no site is at fails with a SharePointSiteNotFoundError', async (t) => {
  using microsoftSide = microsoft(() =>
    refusal(404, 'itemNotFound', 'Requested site could not be found'),
  );

  await assert.rejects(
    microsoftSide.client.site(SITE_URL, t.signal),
    (error: unknown) => {
      assert.ok(error instanceof SharePointSiteNotFoundError);
      assert.equal(error.url, SITE_URL);
      return true;
    },
  );
});

test('a drive delta follows each nextLink and ends at the deltaLink', async (t) => {
  const folder = {
    id: '01FOLDER',
    name: 'Proposals',
    size: 2048,
    folder: { childCount: 1 },
    parentReference: {
      driveId: 'drive-1',
      id: '01ROOT',
      path: '/drives/drive-1/root:',
    },
    webUrl: `${SITE_URL}/Shared%20Documents/Proposals`,
    createdDateTime: '2025-02-03T04:05:06Z',
    lastModifiedDateTime: '2026-11-15T10:00:00Z',
    createdBy: {
      user: { displayName: 'Rana Haddad', email: 'rana@contoso.com' },
    },
    lastModifiedBy: {
      user: { displayName: 'Rana Haddad', email: 'rana@contoso.com' },
    },
    eTag: '"{0A1B2C3D-0000-4000-8000-000000000001},2"',
    cTag: '"c:{0A1B2C3D-0000-4000-8000-000000000001},0"',
    sharepointIds: { listItemId: '7' },
  };
  const file = {
    id: '01FILE',
    name: 'Proposal.docx',
    size: 2048,
    file: {
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      hashes: { quickXorHash: 'aGVsbG8gd29ybGQhISE=' },
    },
    parentReference: {
      driveId: 'drive-1',
      id: '01FOLDER',
      path: '/drives/drive-1/root:/Proposals',
    },
    webUrl: `${SITE_URL}/Shared%20Documents/Proposals/Proposal.docx`,
    createdDateTime: '2025-02-03T04:05:06Z',
    lastModifiedDateTime: '2026-11-15T10:00:00.123Z',
    eTag: '"{0A1B2C3D-0000-4000-8000-000000000002},5"',
    cTag: '"c:{0A1B2C3D-0000-4000-8000-000000000002},3"',
    sharepointIds: { listItemId: '8' },
  };
  const gone = {
    id: '01GONE',
    deleted: { state: 'deleted' },
    parentReference: { driveId: 'drive-1', id: '01FOLDER' },
  };
  const nextLink = `${GRAPH}/drives/drive-1/root/delta?token=page-2`;
  const deltaLink = `${GRAPH}/drives/drive-1/root/delta?token=after-page-2`;
  using microsoftSide = microsoft((url) =>
    url.searchParams.get('token') === 'page-2'
      ? Response.json({ value: [gone], '@odata.deltaLink': deltaLink })
      : Response.json({ value: [folder, file], '@odata.nextLink': nextLink }),
  );

  const pages = await Array.fromAsync(
    microsoftSide.client.driveDelta('drive-1', undefined, t.signal),
  );

  assert.deepEqual(pages, [
    { items: [folder, file], nextLink },
    { items: [gone], deltaLink },
  ]);
  assert.deepEqual(
    microsoftSide
      .graphRequests()
      .map((request) => new URL(request.url).pathname),
    ['/v1.0/drives/drive-1/root/delta', '/v1.0/drives/drive-1/root/delta'],
  );
});

test('a list items delta gives the fields of each item', async (t) => {
  const item = {
    id: '3',
    eTag: '"5a58bb09-1fba-41c1-8125-69da264370a0,4"',
    webUrl: `${SITE_URL}/Lists/Events/3_.000`,
    createdDateTime: '2026-10-01T09:00:00Z',
    lastModifiedDateTime: '2026-11-16T15:30:00Z',
    contentType: { id: '0x0102', name: 'Event' },
    fields: {
      '@odata.etag': '"5a58bb09-1fba-41c1-8125-69da264370a0,4"',
      Title: 'Quarterly review',
      EventDate: '2026-12-01T09:00:00Z',
      Attendees: [{ LookupId: 11, LookupValue: 'Rana Haddad' }],
    },
  };
  const deltaLink = `${GRAPH}/sites/${SITE_ID}/lists/events/items/delta?token=after`;
  using microsoftSide = microsoft((url) =>
    url.searchParams.get('$expand') === 'fields'
      ? Response.json({ value: [item], '@odata.deltaLink': deltaLink })
      : refusal(400, 'invalidRequest', 'Fields were not expanded'),
  );

  const pages = await Array.fromAsync(
    microsoftSide.client.listItemsDelta(SITE_ID, 'events', undefined, t.signal),
  );

  assert.deepEqual(pages, [{ items: [item], deltaLink }]);
});

test('a list items delta follows each nextLink and ends at the deltaLink', async (t) => {
  const item = (id: string, title: string) => ({
    id,
    eTag: `"5a58bb09-1fba-41c1-8125-69da264370a0,${id}"`,
    webUrl: `${SITE_URL}/Lists/Events/${id}_.000`,
    createdDateTime: '2026-10-01T09:00:00Z',
    lastModifiedDateTime: '2026-11-16T15:30:00Z',
    contentType: { id: '0x0102', name: 'Event' },
    fields: { Title: title },
  });
  const first = item('1', 'Kick-off');
  const second = item('2', 'Quarterly review');
  const path = `/v1.0/sites/${SITE_ID}/lists/events/items/delta`;
  const nextLink = `${GRAPH}/sites/${SITE_ID}/lists/events/items/delta?$expand=fields&token=page-2`;
  const deltaLink = `${GRAPH}/sites/${SITE_ID}/lists/events/items/delta?token=after-page-2`;
  using microsoftSide = microsoft((url) => {
    if (url.pathname !== path) return refusal(404, 'itemNotFound', 'Not found');
    if (url.searchParams.get('token') === 'page-2')
      return Response.json({ value: [second], '@odata.deltaLink': deltaLink });
    if (url.searchParams.get('$expand') === 'fields')
      return Response.json({ value: [first], '@odata.nextLink': nextLink });
    return refusal(400, 'invalidRequest', 'Fields were not expanded');
  });

  const pages = await Array.fromAsync(
    microsoftSide.client.listItemsDelta(SITE_ID, 'events', undefined, t.signal),
  );

  assert.deepEqual(pages, [
    { items: [first], nextLink },
    { items: [second], deltaLink },
  ]);
  assert.equal(microsoftSide.graphRequests().length, 2);
});

test('a list read in full gives every item of each page, for a list that Graph serves no delta for', async (t) => {
  const request = (id: string, title: string) => ({
    id,
    eTag: `"5a58bb09-1fba-41c1-8125-69da264370a0,${id}"`,
    webUrl: `${SITE_URL}/Lists/Access Requests/${id}_.000`,
    createdDateTime: '2026-10-01T09:00:00Z',
    lastModifiedDateTime: '2026-11-16T15:30:00Z',
    contentType: { id: '0x01', name: 'Item' },
    fields: { Title: title },
  });
  const second = `${GRAPH}/sites/${SITE_ID}/lists/requests/items?$expand=fields&$skiptoken=2`;
  using microsoftSide = microsoft((url) => {
    // The hidden accessRequest list answers its item delta so at each try.
    if (url.pathname.endsWith('/delta'))
      return refusal(503, 'serviceNotAvailable', 'Service not available');
    if (url.pathname !== `/v1.0/sites/${SITE_ID}/lists/requests/items`)
      return refusal(404, 'itemNotFound', 'Not found');
    if (url.searchParams.get('$expand') !== 'fields')
      return refusal(400, 'invalidRequest', 'Fields were not expanded');
    return url.searchParams.get('$skiptoken') === '2'
      ? Response.json({ value: [request('2', 'Second request')] })
      : Response.json({
          value: [request('1', 'First request')],
          '@odata.nextLink': second,
        });
  });

  const items = await microsoftSide.client.listItems(
    SITE_ID,
    'requests',
    t.signal,
  );

  assert.deepEqual(
    items.map(({ id, fields }) => ({ id, title: fields.Title })),
    [
      { id: '1', title: 'First request' },
      { id: '2', title: 'Second request' },
    ],
  );
});

test('a delta link outside Graph is refused before the token is sent anywhere', async (t) => {
  using microsoftSide = microsoft(
    () => refusal(500, 'unexpected', 'Graph was not asked'),
    http.get('https://attacker.example/*', () => Response.json({ value: [] })),
  );

  await assert.rejects(
    Array.fromAsync(
      microsoftSide.client.driveDelta(
        'drive-1',
        'https://attacker.example/v1.0/drives/drive-1/root/delta?token=x',
        t.signal,
      ),
    ),
    /is not a Microsoft Graph v1\.0 link/,
  );

  assert.deepEqual(
    microsoftSide.requests.map((request) => new URL(request.url).host),
    [],
  );
});

test('a link from a host that only starts like Graph is refused before any request', async (t) => {
  using microsoftSide = microsoft(
    () => refusal(500, 'unexpected', 'Graph was not asked'),
    http.get('https://graph.microsoft.com.evil.example/*', () =>
      Response.json({ value: [] }),
    ),
  );

  await assert.rejects(
    Array.fromAsync(
      microsoftSide.client.driveDelta(
        'drive-1',
        'https://graph.microsoft.com.evil.example/v1.0/drives/drive-1/root/delta?token=x',
        t.signal,
      ),
    ),
    /is not a Microsoft Graph v1\.0 link/,
  );

  assert.deepEqual(microsoftSide.requests, []);
});

test('a nextLink outside Graph in a page of a collection is refused before the request goes there', async (t) => {
  const documents = {
    id: 'b!CbtYWrofwUGBJWnaJkNwoNrBLp_kC3RKklSXPwrdeP0',
    name: 'Documents',
    description: '',
    driveType: 'documentLibrary',
    webUrl: `${SITE_URL}/Shared%20Documents`,
    createdDateTime: '2024-01-02T03:04:05Z',
    lastModifiedDateTime: '2026-11-16T08:00:00Z',
  };
  using microsoftSide = microsoft(
    (url) =>
      url.pathname === `/v1.0/sites/${SITE_ID}/drives`
        ? Response.json({
            value: [documents],
            '@odata.nextLink': `https://attacker.example/v1.0/sites/${SITE_ID}/drives?$skiptoken=2`,
          })
        : refusal(404, 'itemNotFound', 'Not found'),
    http.get('https://attacker.example/*', () => Response.json({ value: [] })),
  );

  await assert.rejects(
    microsoftSide.client.drives(SITE_ID, t.signal),
    /is not a Microsoft Graph v1\.0 link/,
  );

  assert.deepEqual(
    microsoftSide.requests
      .map((request) => new URL(request.url).host)
      .filter((host) => host !== 'login.microsoftonline.com'),
    ['graph.microsoft.com'],
  );
});

test('a delta link that Graph no longer serves fails with a DeltaExpiredError', async (t) => {
  const expired = `${GRAPH}/drives/drive-1/root/delta?token=from-last-year`;
  using microsoftSide = microsoft((url) =>
    url.searchParams.get('token') === 'from-last-year'
      ? refusal(410, 'resyncRequired', 'Resync required.', {
          location: `${GRAPH}/drives/drive-1/root/delta`,
        })
      : Response.json({ value: [], '@odata.deltaLink': expired }),
  );

  await assert.rejects(
    Array.fromAsync(
      microsoftSide.client.driveDelta('drive-1', expired, t.signal),
    ),
    (error: unknown) => {
      assert.ok(error instanceof DeltaExpiredError);
      assert.ok(error.cause instanceof GraphError);
      assert.equal(error.cause.code, 'resyncRequired');
      return true;
    },
  );
});

test('a malformed delta link fails with a GraphError that keeps the status and code of Graph', async (t) => {
  using microsoftSide = microsoft(() =>
    refusal(400, 'invalidRequest', 'Invalid request'),
  );

  await assert.rejects(
    Array.fromAsync(
      microsoftSide.client.driveDelta(
        'drive-1',
        `${GRAPH}/drives/drive-1/root/delta?token=not-a-token`,
        t.signal,
      ),
    ),
    (error: unknown) => {
      assert.ok(error instanceof GraphError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'invalidRequest');
      assert.match(error.message, /400 invalidRequest/);
      return true;
    },
  );
});

test('a download writes the bytes of the file to the path', async (t) => {
  const bytes = Uint8Array.from({ length: 300_000 }, (_, index) => index % 251);
  const signed =
    'https://contoso.sharepoint.com/sites/Sales/_layouts/15/download.aspx';
  using microsoftSide = microsoft(
    (url) =>
      url.pathname === '/v1.0/drives/drive-1/items/01FILE/content'
        ? new Response(null, {
            status: 302,
            headers: { location: `${signed}?UniqueId=01FILE&tempauth=signed` },
          })
        : refusal(404, 'itemNotFound', 'Item not found'),
    http.get(signed, () => new Response(bytes)),
  );
  await using directory = await new TemporaryFiles().directory(
    'sharepoint-download-',
  );
  const path = join(directory.path, 'Proposal.docx');

  await microsoftSide.client.download('drive-1', '01FILE', path, t.signal);

  assert.deepEqual(new Uint8Array(await readFile(path)), bytes);
  const download = microsoftSide.requests.find(
    (request) => new URL(request.url).host === 'contoso.sharepoint.com',
  );
  assert.ok(download !== undefined);
  assert.equal(download.headers.get('authorization'), null);
});

test('a download whose connection breaks before the body arrives rejects', async (t) => {
  const signed =
    'https://contoso.sharepoint.com/sites/Sales/_layouts/15/download.aspx';
  let sent = false;
  using microsoftSide = microsoft(
    (url) =>
      url.pathname === '/v1.0/drives/drive-1/items/01FILE/content'
        ? new Response(null, {
            status: 302,
            headers: { location: `${signed}?UniqueId=01FILE&tempauth=signed` },
          })
        : refusal(404, 'itemNotFound', 'Item not found'),
    http.get(
      signed,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent) controller.error(new Error('the connection was reset'));
              else controller.enqueue(new Uint8Array(64_000));
              sent = true;
            },
          }),
        ),
    ),
  );
  await using directory = await new TemporaryFiles().directory(
    'sharepoint-download-',
  );

  await assert.rejects(
    microsoftSide.client.download(
      'drive-1',
      '01FILE',
      join(directory.path, 'Proposal.docx'),
      t.signal,
    ),
  );
  assert.ok(sent);
});

test('a download whose file cannot be written rejects, so no file passes as stored', async (t) => {
  const signed =
    'https://contoso.sharepoint.com/sites/Sales/_layouts/15/download.aspx';
  using microsoftSide = microsoft(
    (url) =>
      url.pathname === '/v1.0/drives/drive-1/items/01FILE/content'
        ? new Response(null, {
            status: 302,
            headers: { location: `${signed}?UniqueId=01FILE&tempauth=signed` },
          })
        : refusal(404, 'itemNotFound', 'Item not found'),
    http.get(signed, () => new Response(new Uint8Array(64_000))),
  );
  await using directory = await new TemporaryFiles().directory(
    'sharepoint-download-',
  );

  await assert.rejects(
    microsoftSide.client.download(
      'drive-1',
      '01FILE',
      join(directory.path, 'missing folder', 'Proposal.docx'),
      t.signal,
    ),
    { code: 'ENOENT' },
  );
});

test('a site version changes when the lastModifiedDateTime of a list changes', async () => {
  const documents = {
    id: 'documents',
    name: 'Shared Documents',
    displayName: 'Documents',
    webUrl: `${SITE_URL}/Shared%20Documents`,
    createdDateTime: '2024-01-02T03:04:05Z',
    lastModifiedDateTime: '2026-11-16T08:00:00Z',
    list: {
      template: 'documentLibrary',
      hidden: false,
      contentTypesEnabled: false,
    },
  };
  const home = {
    id: 'home',
    name: 'Home.aspx',
    title: 'Home',
    webUrl: `${SITE_URL}/SitePages/Home.aspx`,
    lastModifiedDateTime: '2026-11-10T08:00:00Z',
  };
  using microsoftSide = microsoft((url) => {
    if (url.pathname === '/v1.0/sites/contoso.sharepoint.com:/sites/Sales')
      return Response.json(sales);
    if (url.pathname === `/v1.0/sites/${SITE_ID}/lists`)
      return Response.json({ value: [documents] });
    if (url.pathname === `/v1.0/sites/${SITE_ID}/pages`)
      return Response.json({ value: [home] });
    return refusal(404, 'itemNotFound', 'Not found');
  });
  const version = new SiteVersion(microsoftSide.client, SITE_URL);
  const stop = new AbortController();
  // A Check cannot be built outside a watch, so the version is read through one.
  const checks = new ChangeWatcher([version], {
    interval: 1,
    timeout: 5000,
    clock: globalThis,
  }).watch(stop.signal);
  try {
    const outcomes: (Outcome | undefined)[] = [];
    for (const step of [
      () => {},
      () => {},
      () => {
        documents.lastModifiedDateTime = '2026-11-17T09:30:00Z';
      },
    ]) {
      step();
      outcomes.push((await checks.next()).value?.get(version));
    }

    assert.deepEqual(outcomes, [
      { state: 'changed' },
      { state: 'unchanged' },
      { state: 'changed' },
    ]);
  } finally {
    stop.abort();
    await checks.return();
  }
});

test('a site version changes when the lastModifiedDateTime of a page changes, and stays when nothing changed', async () => {
  const documents = {
    id: 'documents',
    name: 'Shared Documents',
    displayName: 'Documents',
    webUrl: `${SITE_URL}/Shared%20Documents`,
    createdDateTime: '2024-01-02T03:04:05Z',
    lastModifiedDateTime: '2026-11-16T08:00:00Z',
    list: {
      template: 'documentLibrary',
      hidden: false,
      contentTypesEnabled: false,
    },
  };
  const home = {
    id: 'home',
    name: 'Home.aspx',
    title: 'Home',
    webUrl: `${SITE_URL}/SitePages/Home.aspx`,
    lastModifiedDateTime: '2026-11-10T08:00:00Z',
  };
  using microsoftSide = microsoft((url) => {
    if (url.pathname === '/v1.0/sites/contoso.sharepoint.com:/sites/Sales')
      return Response.json(sales);
    if (url.pathname === `/v1.0/sites/${SITE_ID}/lists`)
      return Response.json({ value: [documents] });
    if (url.pathname === `/v1.0/sites/${SITE_ID}/pages`)
      return Response.json({ value: [home] });
    return refusal(404, 'itemNotFound', 'Not found');
  });
  const version = new SiteVersion(microsoftSide.client, SITE_URL);
  const stop = new AbortController();
  // A Check cannot be built outside a watch, so the version is read through one.
  const checks = new ChangeWatcher([version], {
    interval: 1,
    timeout: 5000,
    clock: globalThis,
  }).watch(stop.signal);
  try {
    const outcomes: (Outcome | undefined)[] = [];
    for (const step of [
      () => {},
      () => {},
      () => {
        home.lastModifiedDateTime = '2026-11-17T09:30:00Z';
      },
      () => {},
    ]) {
      step();
      outcomes.push((await checks.next()).value?.get(version));
    }

    assert.deepEqual(outcomes, [
      { state: 'changed' },
      { state: 'unchanged' },
      { state: 'changed' },
      { state: 'unchanged' },
    ]);
  } finally {
    stop.abort();
    await checks.return();
  }
});
