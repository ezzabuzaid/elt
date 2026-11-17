import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { createClock } from '@sinonjs/fake-timers';
import { TemporaryFiles } from '@zukhruf/fs';
import { open } from '@zukhruf/sqlite-open';
import { Msw } from '@zukhruf/testing/msw';
import { http } from 'msw';
import { parseOffice } from 'officeparser';

import {
  Connection,
  Copy,
  type CopyResult,
  DocumentText,
  LocalFiles,
  Pipeline,
  type PipelineClock,
  PipelineError,
  type Target,
} from '@eltjs/elt';
import {
  ComputedDataset,
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@eltjs/elt-sqlite';
import { OfficeDocumentParser } from '@eltjs/parser-office/office-document-parser';
import {
  SharePointAccessError,
  SharePointClient,
  SharePointCredentialsError,
} from '@eltjs/sdk-microsoft-sharepoint';

import { SharePointSource } from './sharepoint-source.ts';

// --- Graph: the sites of one tenant, stubbed below fetch with msw ----------

const TENANT = '0b7f3f60-1f2c-4c5e-9d0a-6a1f2e3d4c5b';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SALES = 'https://contoso.sharepoint.com/sites/Sales';
const MARKETING = 'https://contoso.sharepoint.com/sites/Marketing';
const CREATED = '2026-01-02T03:04:05Z';
const MODIFIED = '2026-11-16T08:00:00Z';
const sam = {
  user: { id: 'u-sam', displayName: 'Sam', email: 'sam@contoso.com' },
};

type Json = Record<string, unknown>;

// The items of one delta query, a drive or a list, and each change to them
// in order. A delta link names how many changes it read; one that names
// fewer than expiredBefore answers 410, as Graph does after it stops keeping
// the changes.
class Feed {
  readonly items = new Map<string, Json>();
  readonly #changed: string[] = [];
  expiredBefore = 0;

  constructor(items: readonly Json[] = []) {
    for (const item of items) this.put(item);
  }

  get version(): number {
    return this.#changed.length;
  }

  put(item: Json): void {
    this.items.set(String(item.id), item);
    this.#changed.push(String(item.id));
  }

  remove(id: string): void {
    this.items.delete(id);
    this.#changed.push(id);
  }

  // Each item that changed after version, once, as it is now.
  changesAfter(version: number): Json[] {
    return [...new Set(this.#changed.slice(version))].map(
      (id) => this.items.get(id) ?? { id, deleted: { state: 'deleted' } },
    );
  }
}

type FakeDrive = {
  readonly id: string;
  readonly name: string;
  readonly feed: Feed;
};

type FakeList = {
  readonly id: string;
  readonly name: string;
  readonly template: string;
  readonly hidden: boolean;
  readonly columns: readonly Json[];
  readonly feed: Feed;
  lastModifiedDateTime: string;
};

type FakePage = {
  readonly id: string;
  readonly title: string;
  readonly parts: readonly string[];
};

type FakeSite = {
  readonly url: string;
  readonly id: string;
  // The status Graph answers each read of the site with, when it refuses it.
  refusal?: number;
  drives: FakeDrive[];
  lists: FakeList[];
  readonly pages: FakePage[];
  // The content of each file, by its item ID.
  readonly contents: Map<string, Uint8Array>;
};

type World = {
  readonly sites: readonly FakeSite[];
  // Items per page of a first delta read.
  readonly pageSize: number;
  // Answers a request before the routes do, when it gives a response.
  intercept?: (url: URL) => Response | undefined;
  // Entra ID refuses the client secret, as for a wrong or expired one.
  refusesSecret?: boolean;
};

const driveRoot = (driveId: string): Json => ({
  id: `${driveId}-root`,
  name: 'root',
  size: 0,
  root: {},
  folder: { childCount: 1 },
  parentReference: { driveId },
  webUrl: `${SALES}/Shared Documents`,
  createdDateTime: CREATED,
  lastModifiedDateTime: MODIFIED,
});

function driveFile(
  driveId: string,
  id: string,
  name: string,
  {
    size = 100,
    modified = MODIFIED,
  }: { size?: number; modified?: string } = {},
): Json {
  return {
    id,
    name,
    size,
    file: {
      mimeType: 'application/octet-stream',
      hashes: { quickXorHash: `quick-${id}` },
    },
    parentReference: {
      driveId,
      id: `${driveId}-root`,
      path: `/drives/${driveId}/root:`,
    },
    webUrl: `${SALES}/Shared Documents/${name}`,
    createdDateTime: CREATED,
    lastModifiedDateTime: modified,
    createdBy: sam,
    lastModifiedBy: sam,
    eTag: `"{${id}},1"`,
    cTag: `"c:{${id}},1"`,
    sharepointIds: { listItemId: id },
  };
}

function driveFolder(driveId: string, id: string, name: string): Json {
  return {
    id,
    name,
    size: 0,
    folder: { childCount: 0 },
    parentReference: {
      driveId,
      id: `${driveId}-root`,
      path: `/drives/${driveId}/root:`,
    },
    webUrl: `${SALES}/Shared Documents/${name}`,
    createdDateTime: CREATED,
    lastModifiedDateTime: MODIFIED,
    createdBy: sam,
    lastModifiedBy: sam,
    eTag: `"{${id}},1"`,
  };
}

function listItem(id: string, fields: Json): Json {
  return {
    id,
    eTag: `"${id},1"`,
    webUrl: `${SALES}/Lists/Projects/${id}_.000`,
    createdDateTime: CREATED,
    lastModifiedDateTime: MODIFIED,
    createdBy: sam,
    lastModifiedBy: sam,
    contentType: { id: '0x0100', name: 'Item' },
    fields: { id, ...fields },
  };
}

const textColumn = (id: string, name: string): Json => ({
  id,
  name,
  displayName: name,
  hidden: false,
  indexed: false,
  readOnly: false,
  required: false,
  enforceUniqueValues: false,
  text: { allowMultipleLines: false, maxLength: 255 },
});

// The Sales site: a Documents library with a folder and a file, a Projects
// list, a hidden list of access requests and a home page.
function salesSite(): FakeSite {
  return {
    url: SALES,
    id: 'contoso.sharepoint.com,5a58bb09-1fba-41c1-8125-69da264370a0,9f2ec1da-0be4-4a74-9254-973f0add78fd',
    drives: [
      {
        id: 'b!documents',
        name: 'Documents',
        feed: new Feed([
          driveFolder('b!documents', 'folder-proposals', 'Proposals'),
          driveFile('b!documents', 'file-budget', 'Budget.xlsx', {
            size: 7_700_000_000,
          }),
        ]),
      },
    ],
    lists: [
      {
        id: 'list-documents',
        name: 'Shared Documents',
        template: 'documentLibrary',
        hidden: false,
        columns: [textColumn('col-title', 'Title')],
        feed: new Feed(),
        lastModifiedDateTime: MODIFIED,
      },
      {
        id: 'list-projects',
        name: 'Projects',
        template: 'genericList',
        hidden: false,
        columns: [
          textColumn('col-title', 'Title'),
          {
            ...textColumn('col-status', 'Status'),
            text: undefined,
            choice: { choices: ['Active', 'Done'] },
          },
        ],
        feed: new Feed([listItem('1', { Title: 'Launch', Status: 'Active' })]),
        lastModifiedDateTime: MODIFIED,
      },
      {
        id: 'list-access',
        name: 'Access Requests',
        template: 'accessRequest',
        hidden: true,
        columns: [textColumn('col-title', 'Title')],
        feed: new Feed([listItem('7', { Title: 'Request from Kim' })]),
        lastModifiedDateTime: MODIFIED,
      },
    ],
    pages: [
      {
        id: 'page-home',
        title: 'Home',
        parts: ['<p>Welcome to Sales</p>', '<p>Proposals are in Documents</p>'],
      },
    ],
    contents: new Map(),
  };
}

// An error as Graph answers one.
function refusal(status: number, code: string, headers?: HeadersInit) {
  return Response.json(
    { error: { code, message: `Graph answered ${code}` } },
    { status, headers },
  );
}

// One page of the delta of feed at base: a first read pages through the
// items, which a drive gives after its root folder on each page (live,
// 2026-11-17), and a delta link reads every change after it in one page.
function delta(
  world: World,
  feed: Feed,
  base: string,
  url: URL,
  root?: Json,
): Response {
  const token = url.searchParams.get('token');
  const first = root === undefined ? [] : [root];
  const link = (value: string) => `${base}?token=${value}`;
  if (token === null || token.startsWith('start.')) {
    const [, since = String(feed.version), offset = '0'] =
      token?.split('.') ?? [];
    const all = [...feed.items.values()];
    const end = Number(offset) + world.pageSize;
    return Response.json({
      value: [...first, ...all.slice(Number(offset), end)],
      ...(end < all.length
        ? { '@odata.nextLink': link(`start.${since}.${end}`) }
        : { '@odata.deltaLink': link(`delta.${since}`) }),
    });
  }
  const version = Number(token.slice('delta.'.length));
  if (version < feed.expiredBefore) return refusal(410, 'resyncRequired');
  return Response.json({
    value: [...first, ...feed.changesAfter(version)],
    '@odata.deltaLink': link(`delta.${feed.version}`),
  });
}

function route(world: World, url: URL): Response {
  const path = decodeURIComponent(url.pathname.slice('/v1.0'.length));
  const byUrl = /^\/sites\/([^/]+):(\/.+)$/.exec(path);
  if (byUrl !== null) {
    const site = world.sites.find(
      ({ url: siteUrl }) => siteUrl === `https://${byUrl[1]}${byUrl[2]}`,
    );
    if (site === undefined) return refusal(404, 'itemNotFound');
    if (site.refusal !== undefined)
      return refusal(site.refusal, 'accessDenied');
    return Response.json({
      id: site.id,
      name: byUrl[2]?.split('/').at(-1),
      displayName: byUrl[2]?.split('/').at(-1),
      webUrl: site.url,
      createdDateTime: CREATED,
      lastModifiedDateTime: MODIFIED,
    });
  }
  const [, kind = '', first = '', rest = ''] =
    /^\/(sites|drives)\/([^/]+)(.*)$/.exec(path) ?? [];
  if (kind === 'drives') {
    const drive = world.sites
      .flatMap((site) => site.drives.map((entry) => ({ site, entry })))
      .find(({ entry }) => entry.id === first);
    if (drive === undefined) return refusal(404, 'itemNotFound');
    if (rest === '/root/delta')
      return delta(
        world,
        drive.entry.feed,
        `${GRAPH}/drives/${first}/root/delta`,
        url,
        driveRoot(first),
      );
    const content = /^\/items\/([^/]+)\/content$/.exec(rest);
    const bytes = drive.site.contents.get(content?.[1] ?? '');
    if (content !== null)
      return bytes === undefined
        ? refusal(404, 'itemNotFound')
        : new Response(Buffer.from(bytes));
  }
  const site = world.sites.find(({ id }) => id === first);
  if (kind !== 'sites' || site === undefined)
    return refusal(400, `unstubbed ${path}`);
  if (rest === '/drives')
    return Response.json({
      value: site.drives.map(({ id, name }) => ({
        id,
        name,
        driveType: 'documentLibrary',
        webUrl: `${site.url}/${name}`,
        createdDateTime: CREATED,
        lastModifiedDateTime: MODIFIED,
      })),
    });
  if (rest === '/lists')
    return Response.json({
      value: site.lists.map((list) => ({
        id: list.id,
        name: list.name,
        displayName: list.name,
        webUrl: `${site.url}/Lists/${list.name}`,
        createdDateTime: CREATED,
        lastModifiedDateTime: list.lastModifiedDateTime,
        list: {
          template: list.template,
          hidden: list.hidden,
          contentTypesEnabled: false,
        },
      })),
    });
  if (rest === '/pages')
    return Response.json({
      value: site.pages.map(({ id, title }) => ({
        id,
        name: `${title}.aspx`,
        title,
        webUrl: `${site.url}/SitePages/${title}.aspx`,
        pageLayout: 'home',
        eTag: `"{${id}},3"`,
        createdDateTime: CREATED,
        lastModifiedDateTime: MODIFIED,
        createdBy: sam,
        lastModifiedBy: sam,
        publishingState: { level: 'published', versionId: '3.0' },
      })),
    });
  const page = /^\/pages\/([^/]+)\/microsoft\.graph\.sitePage$/.exec(rest);
  if (page !== null)
    return Response.json({
      canvasLayout: {
        horizontalSections: [
          {
            columns: [
              {
                webparts: [
                  {
                    '@odata.type': '#microsoft.graph.standardWebPart',
                    id: 'image',
                  },
                  ...(
                    site.pages.find(({ id }) => id === page[1])?.parts ?? []
                  ).map((innerHtml, index) => ({
                    '@odata.type': '#microsoft.graph.textWebPart',
                    id: `text-${index}`,
                    innerHtml,
                  })),
                ],
              },
            ],
          },
        ],
      },
    });
  const [, listId = '', items = ''] = /^\/lists\/([^/]+)(.*)$/.exec(rest) ?? [];
  const list = site.lists.find(({ id }) => id === listId);
  if (list === undefined) return refusal(404, 'itemNotFound');
  if (items === '/columns') return Response.json({ value: list.columns });
  // Graph refuses the item delta of a list of access requests on each try
  // (live, 2026-11-17).
  if (items === '/items/delta' && list.template === 'accessRequest')
    return refusal(503, 'serviceNotAvailable', { 'retry-after': '0' });
  if (items === '/items/delta')
    return delta(
      world,
      list.feed,
      `${GRAPH}/sites/${site.id}/lists/${listId}/items/delta`,
      url,
    );
  if (items === '/items')
    return Response.json({ value: [...list.feed.items.values()] });
  return refusal(400, `unstubbed ${path}`);
}

// Microsoft's side of the wire: the token endpoint of Entra ID and Graph.
// Any other request fails the test.
function microsoft(world: World) {
  const server = new Msw().intercept(
    http.post(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      () =>
        world.refusesSecret === true
          ? Response.json(
              {
                error: 'invalid_client',
                error_description:
                  "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app 'client-id'.",
                error_codes: [7000215],
              },
              { status: 401 },
            )
          : Response.json({
              token_type: 'Bearer',
              access_token: 'app-token',
              expires_in: 3599,
              ext_expires_in: 3599,
            }),
    ),
    http.get('https://graph.microsoft.com/*', ({ request }) => {
      const url = new URL(request.url);
      return world.intercept?.(url) ?? route(world, url);
    }),
  );
  return {
    // Each Graph request so far, as its decoded path and query.
    requests: () =>
      server.requests
        .map(({ url }) => new URL(url))
        .filter(({ host }) => host === 'graph.microsoft.com')
        .map(({ pathname, search }) =>
          decodeURIComponent(pathname.slice('/v1.0'.length) + search),
        ),
    source: (sites: readonly string[] = [SALES]) =>
      new SharePointSource({
        client: new SharePointClient({
          tenantId: TENANT,
          clientId: 'client-id',
          clientSecret: 'client-secret',
          clock: globalThis,
        }),
        sites,
      }),
    [Symbol.dispose]: () => server.cleanup(),
  };
}

// --- The warehouse: the host's copies into SQLite ---------------------------

// The host's import: an incremental copy of each stream into a table of its
// name. With documents, the driveItems copy stores each file that the Office
// parser reads, and a DocumentText dataset derives their text.
async function warehouse(
  source: SharePointSource,
  directory: string,
  {
    documents = false,
    clock = globalThis,
  }: { documents?: boolean; clock?: PipelineClock } = {},
) {
  const destination = new SQLiteDestination({
    path: join(directory, 'warehouse.sqlite'),
  });
  const files = new LocalFiles({ directory: join(directory, 'files') });
  const parser = new OfficeDocumentParser();
  const { streams } = await source.discover();
  const targets = new Map(
    streams.map((stream) => [
      stream,
      destination.table(
        stream.name,
        documents && stream === source.driveItems
          ? (c) => [
              ...SQLiteColumns.fromSchema(stream.jsonSchema),
              c
                .text('documentRef')
                .from(stream.file.accepting(parser).store(files)),
            ]
          : undefined,
      ),
    ]),
  );
  const driveItems = targets.get(source.driveItems);
  assert.ok(driveItems !== undefined);
  return new Pipeline({
    clock,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'sharepoint',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(directory, 'checkpoints.sqlite'),
        }),
        steps: [...targets].map(
          ([stream, target]) =>
            new Copy(stream, target, {
              id: `${source.identity}/${stream.name}`,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
    derived: documents
      ? [
          new ComputedDataset({
            into: destination,
            name: 'document_text',
            description: 'The text of each stored document.',
            from: [driveItems],
            compute: new DocumentText({
              parser: () => parser,
              files: files.directory,
              column: 'documentRef',
            }),
          }),
        ]
      : [],
  });
}

function rows(directory: string, sql: string) {
  using db = open(join(directory, 'warehouse.sqlite'), { readOnly: true });
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

const column = (directory: string, sql: string) =>
  rows(directory, sql).map((row) => Object.values(row)[0]);

const counts = (results: readonly CopyResult<Target>[]) =>
  Object.fromEntries(
    results.map(({ copy, count, deleted }) => [
      copy.from.name,
      { count, deleted },
    ]),
  );

const nothing = { count: 0, deleted: 0 };

// A run that fails: the failures of each copy that failed, by stream.
async function failedRun(run: Promise<unknown>) {
  const error = await run.then(
    () => assert.fail('the run succeeded'),
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof PipelineError);
  return Object.fromEntries(
    error.results
      .filter(({ failures }) => failures.length > 0)
      .map(({ copy, failures }) => [copy.from.name, failures]),
  );
}

// A Word document with this Markdown, made by officeparser.
async function wordDocument(markdown: string): Promise<Uint8Array> {
  const document = await parseOffice(Buffer.from(markdown), { fileType: 'md' });
  const { value } = await document.to('docx');
  return value;
}

// --- Tests -------------------------------------------------------------------

test('a first run loads every stream of the site, with Graph values in the forms elt keeps', async () => {
  await using dir = await new TemporaryFiles().directory('sharepoint-');
  using graph = microsoft({ sites: [salesSite()], pageSize: 200 });

  await (await warehouse(graph.source(), dir.path)).run();

  assert.deepEqual(
    rows(dir.path, 'SELECT siteUrl, siteId, displayName FROM sites'),
    [
      {
        siteUrl: SALES,
        siteId: salesSite().id,
        displayName: 'Sales',
      },
    ],
  );
  assert.deepEqual(column(dir.path, 'SELECT name FROM drives'), ['Documents']);
  assert.deepEqual(
    rows(
      dir.path,
      'SELECT name, isFolder, size, mimeType, parentId, path, lastModifiedDateTime, createdBy, listItemId FROM driveItems ORDER BY name',
    ),
    [
      {
        name: 'Budget.xlsx',
        isFolder: 0,
        size: 7_700_000_000,
        mimeType: 'application/octet-stream',
        parentId: 'b!documents-root',
        path: '/drives/b!documents/root:',
        lastModifiedDateTime: '2026-11-16T08:00:00.000Z',
        createdBy: JSON.stringify(sam),
        listItemId: 'file-budget',
      },
      {
        name: 'Proposals',
        isFolder: 1,
        size: 0,
        mimeType: null,
        parentId: 'b!documents-root',
        path: '/drives/b!documents/root:',
        lastModifiedDateTime: '2026-11-16T08:00:00.000Z',
        createdBy: JSON.stringify(sam),
        listItemId: null,
      },
    ],
  );
  assert.deepEqual(
    rows(dir.path, 'SELECT name, template, hidden FROM lists ORDER BY name'),
    [
      { name: 'Access Requests', template: 'accessRequest', hidden: 1 },
      { name: 'Projects', template: 'genericList', hidden: 0 },
      { name: 'Shared Documents', template: 'documentLibrary', hidden: 0 },
    ],
  );
  assert.deepEqual(
    rows(
      dir.path,
      "SELECT name, type, settings FROM listColumns WHERE listId = 'list-projects' ORDER BY name",
    ),
    [
      {
        name: 'Status',
        type: 'choice',
        settings: JSON.stringify({ choices: ['Active', 'Done'] }),
      },
      {
        name: 'Title',
        type: 'text',
        settings: JSON.stringify({ allowMultipleLines: false, maxLength: 255 }),
      },
    ],
  );
  assert.deepEqual(
    rows(dir.path, 'SELECT listId, itemId, contentType, fields FROM listItems'),
    [
      {
        listId: 'list-projects',
        itemId: '1',
        contentType: 'Item',
        fields: JSON.stringify({ id: '1', Title: 'Launch', Status: 'Active' }),
      },
    ],
  );
  assert.deepEqual(
    rows(dir.path, 'SELECT listId, itemId FROM accessRequests'),
    [{ listId: 'list-access', itemId: '7' }],
  );
  assert.deepEqual(
    rows(dir.path, 'SELECT title, publishingLevel, html FROM pages'),
    [
      {
        title: 'Home',
        publishingLevel: 'published',
        html: '<p>Welcome to Sales</p>\n<p>Proposals are in Documents</p>',
      },
    ],
  );
});

test('a second run with no change in SharePoint writes nothing', async () => {
  await using dir = await new TemporaryFiles().directory('sharepoint-');
  using graph = microsoft({ sites: [salesSite()], pageSize: 200 });
  const pipeline = await warehouse(graph.source(), dir.path);
  await pipeline.run();

  const second = await pipeline.run();

  assert.deepEqual(counts(second), {
    sites: nothing,
    drives: nothing,
    driveItems: nothing,
    lists: nothing,
    listColumns: nothing,
    listItems: nothing,
    accessRequests: nothing,
    pages: nothing,
  });
});

test('a change that the delta reports updates its row, and a deleted file and a deleted list item remove theirs', async () => {
  await using dir = await new TemporaryFiles().directory('sharepoint-');
  const sales = salesSite();
  using graph = microsoft({ sites: [sales], pageSize: 200 });
  const pipeline = await warehouse(graph.source(), dir.path);
  await pipeline.run();
  const [documents] = sales.drives;
  const projects = sales.lists.find(({ id }) => id === 'list-projects');
  assert.ok(documents !== undefined && projects !== undefined);
  documents.feed.put(
    driveFile('b!documents', 'file-budget', 'Budget 2027.xlsx', {
      modified: '2026-11-17T10:00:00Z',
    }),
  );
  documents.feed.remove('folder-proposals');
  projects.feed.put(listItem('2', { Title: 'Pricing', Status: 'Active' }));
  projects.feed.remove('1');

  const second = await pipeline.run();

  assert.deepEqual(
    rows(dir.path, 'SELECT itemId, name, lastModifiedDateTime FROM driveItems'),
    [
      {
        itemId: 'file-budget',
        name: 'Budget 2027.xlsx',
        lastModifiedDateTime: '2026-11-17T10:00:00.000Z',
      },
    ],
  );
  assert.deepEqual(column(dir.path, 'SELECT itemId FROM listItems'), ['2']);
  assert.deepEqual(counts(second).driveItems, { count: 1, deleted: 1 });
  assert.deepEqual(counts(second).listItems, { count: 1, deleted: 1 });
});

test('a delta link that Graph no longer serves reloads the site, and a reload that fails resumes at the next link it saved', async () => {
  await using dir = await new TemporaryFiles().directory('sharepoint-');
  const sales = salesSite();
  const [documents] = sales.drives;
  assert.ok(documents !== undefined);
  for (const name of ['a', 'b', 'c'])
    documents.feed.put(
      driveFile('b!documents', `file-${name}`, `${name}.docx`),
    );
  const world: World = { sites: [sales], pageSize: 2 };
  using graph = microsoft(world);
  const pipeline = await warehouse(graph.source(), dir.path);
  await pipeline.run();
  documents.feed.remove('file-a');
  documents.feed.put(driveFile('b!documents', 'file-d', 'd.docx'));
  documents.feed.expiredBefore = documents.feed.version;
  // The reload reads from the start again; its third page fails.
  const reloadPage = (url: URL, offset: string) =>
    url.pathname.endsWith('/root/delta') &&
    url.searchParams.get('token')?.startsWith('start.') === true &&
    url.searchParams.get('token')?.endsWith(`.${offset}`) === true;
  world.intercept = (url) =>
    reloadPage(url, '4') ? refusal(500, 'generalException') : undefined;
  const failed = await failedRun(pipeline.run());
  world.intercept = undefined;
  const asked = graph.requests().length;

  await pipeline.run();

  assert.deepEqual(Object.keys(failed), ['driveItems']);
  const resumed = graph
    .requests()
    .slice(asked)
    .filter((request) => request.startsWith('/drives/b!documents/root/delta'));
  assert.equal(resumed.length, 1);
  assert.match(resumed[0] ?? '', /token=start\.\d+\.4$/);
  assert.deepEqual(
    column(dir.path, 'SELECT name FROM driveItems ORDER BY name'),
    ['Budget.xlsx', 'Proposals', 'b.docx', 'c.docx', 'd.docx'],
  );
});

test('a first load that fails resumes at the next link it saved, without reading its first page again', async () => {
  await using dir = await new TemporaryFiles().directory('sharepoint-');
  const sales = salesSite();
  const [documents] = sales.drives;
  assert.ok(documents !== undefined);
  for (const name of ['a', 'b', 'c'])
    documents.feed.put(
      driveFile('b!documents', `file-${name}`, `${name}.docx`),
    );
  const world: World = { sites: [sales], pageSize: 2 };
  using graph = microsoft(world);
  const pipeline = await warehouse(graph.source(), dir.path);
  world.intercept = (url) =>
    url.searchParams.get('token')?.endsWith('.4') === true
      ? refusal(500, 'generalException')
      : undefined;
  const failed = await failedRun(pipeline.run());
  const committed = column(
    dir.path,
    'SELECT name FROM driveItems ORDER BY name',
  );
  world.intercept = undefined;
  const asked = graph.requests().length;

  await pipeline.run();

  assert.deepEqual(Object.keys(failed), ['driveItems']);
  assert.deepEqual(committed, ['Budget.xlsx', 'Proposals', 'a.docx', 'b.docx']);
  assert.deepEqual(
    graph
      .requests()
      .slice(asked)
      .filter((request) =>
        request.startsWith('/drives/b!documents/root/delta'),
      ),
    ['/drives/b!documents/root/delta?token=start.5.4'],
  );
  assert.deepEqual(
    column(dir.path, 'SELECT name FROM driveItems ORDER BY name'),
    ['Budget.xlsx', 'Proposals', 'a.docx', 'b.docx', 'c.docx'],
  );
});

test('a stored Word document gets its text and a damaged one an error, and no photo is downloaded', async () => {
  await using dir = await new TemporaryFiles().directory('sharepoint-');
  const sales = salesSite();
  const [documents] = sales.drives;
  assert.ok(documents !== undefined);
  documents.feed.remove('file-budget');
  documents.feed.put(
    driveFile('b!documents', 'file-proposal', 'Proposal.docx'),
  );
  documents.feed.put(driveFile('b!documents', 'file-broken', 'Broken.docx'));
  documents.feed.put(driveFile('b!documents', 'file-photo', 'Team.jpg'));
  sales.contents.set(
    'file-proposal',
    await wordDocument('# Proposal\n\nShip the parser by Friday.\n'),
  );
  sales.contents.set('file-broken', Buffer.from('not a zip archive'));
  sales.contents.set('file-photo', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  using graph = microsoft({ sites: [sales], pageSize: 200 });

  await (await warehouse(graph.source(), dir.path, { documents: true })).run();

  assert.deepEqual(
    graph.requests().filter((request) => request.endsWith('/content')),
    [
      '/drives/b!documents/items/file-proposal/content',
      '/drives/b!documents/items/file-broken/content',
    ],
  );
  const text = rows(
    dir.path,
    `SELECT d.name, t.status, t.content, t.error FROM driveItems d
     LEFT JOIN document_text t ON t.ref = d.documentRef
     WHERE d.isFolder = 0 ORDER BY d.name`,
  );
  assert.deepEqual(
    text.map(({ name, status, content }) => ({ name, status, content })),
    [
      { name: 'Broken.docx', status: 'failed', content: null },
      {
        name: 'Proposal.docx',
        status: 'computed',
        content: 'Proposal\nShip the parser by Friday.',
      },
      { name: 'Team.jpg', status: null, content: null },
    ],
  );
  assert.match(String(text[0]?.error), /officeparser refused .*\.docx/);
});

test('a file deleted after the delta listed it loads without its content', async () => {
  await using dir = await new TemporaryFiles().directory('sharepoint-');
  const sales = salesSite();
  const [documents] = sales.drives;
  assert.ok(documents !== undefined);
  // Its content answers 404: no content is stubbed for it.
  documents.feed.put(driveFile('b!documents', 'file-gone', 'Gone.docx'));
  using graph = microsoft({ sites: [sales], pageSize: 200 });

  await (await warehouse(graph.source(), dir.path, { documents: true })).run();

  assert.deepEqual(
    rows(
      dir.path,
      "SELECT name, documentRef FROM driveItems WHERE name = 'Gone.docx'",
    ),
    [{ name: 'Gone.docx', documentRef: null }],
  );
});

test('a site that refuses the app fails only its own partition, as a config failure', async () => {
  await using dir = await new TemporaryFiles().directory('sharepoint-');
  const marketing: FakeSite = {
    ...salesSite(),
    url: MARKETING,
    id: 'contoso.sharepoint.com,1,2',
    refusal: 403,
  };
  using graph = microsoft({ sites: [salesSite(), marketing], pageSize: 200 });

  const failed = await failedRun(
    (await warehouse(graph.source([MARKETING, SALES]), dir.path)).run(),
  );

  for (const [stream, failures] of Object.entries(failed)) {
    assert.equal(failures.length, 1, stream);
    assert.deepEqual(failures[0]?.partition, { siteUrl: MARKETING });
    assert.equal(failures[0]?.failureType, 'config');
    assert.ok(failures[0]?.error instanceof SharePointAccessError);
  }
  assert.equal(Object.keys(failed).length, 8);
  assert.deepEqual(column(dir.path, 'SELECT siteUrl FROM sites'), [SALES]);
  assert.deepEqual(
    column(dir.path, 'SELECT DISTINCT siteUrl FROM driveItems'),
    [SALES],
  );
});

test('a client secret that Entra ID refuses fails every stream as a config failure', async () => {
  await using dir = await new TemporaryFiles().directory('sharepoint-');
  using graph = microsoft({
    sites: [salesSite()],
    pageSize: 200,
    refusesSecret: true,
  });

  const failed = await failedRun(
    (await warehouse(graph.source(), dir.path)).run(),
  );

  assert.equal(Object.keys(failed).length, 8);
  for (const [stream, failures] of Object.entries(failed)) {
    assert.equal(failures[0]?.failureType, 'config', stream);
    assert.ok(failures[0]?.error instanceof SharePointCredentialsError, stream);
  }
  assert.deepEqual(graph.requests(), []);
});

test('a change to the version of a site wakes the streams of a watch', async (t: TestContext) => {
  await using dir = await new TemporaryFiles().directory('sharepoint-');
  const sales = salesSite();
  using graph = microsoft({ sites: [sales], pageSize: 200 });
  const clock = createClock(Date.UTC(2026, 10, 17, 9, 0));
  const controller = new AbortController();
  const watch = (await warehouse(graph.source(), dir.path, { clock })).watch({
    signal: controller.signal,
  });
  try {
    const first = await watch.next();
    assert.ok(!first.done);
    const projects = sales.lists.find(({ id }) => id === 'list-projects');
    assert.ok(projects !== undefined);
    projects.feed.put(listItem('2', { Title: 'Pricing', Status: 'Active' }));
    projects.lastModifiedDateTime = '2026-11-17T09:00:30Z';

    const next = watch.next();
    await t.waitFor(() => assert.ok(clock.countTimers() > 0));
    await clock.tickAsync(60_000);
    const woken = await next;

    assert.ok(!woken.done);
    assert.deepEqual(
      Object.fromEntries(
        woken.value.outcomes.map(({ copy, count }) => [copy.from.name, count]),
      ),
      {
        sites: 0,
        drives: 0,
        driveItems: 0,
        lists: 1,
        listColumns: 0,
        listItems: 1,
        accessRequests: 0,
        pages: 0,
      },
    );
  } finally {
    controller.abort();
    await watch.return(undefined);
  }
});

test('the root folder that a drive delta repeats on each page loads no row', async () => {
  await using dir = await new TemporaryFiles().directory('sharepoint-');
  using graph = microsoft({ sites: [salesSite()], pageSize: 1 });

  await (await warehouse(graph.source(), dir.path)).run();

  assert.deepEqual(
    column(dir.path, 'SELECT itemId FROM driveItems ORDER BY itemId'),
    ['file-budget', 'folder-proposals'],
  );
});

test('the items of a list of access requests load through their own snapshot stream, which no delta reads', async () => {
  await using dir = await new TemporaryFiles().directory('sharepoint-');
  const sales = salesSite();
  const access = sales.lists.find(({ id }) => id === 'list-access');
  assert.ok(access !== undefined);
  access.feed.put(listItem('8', { Title: 'Request from Lee' }));
  using graph = microsoft({ sites: [sales], pageSize: 200 });
  const pipeline = await warehouse(graph.source(), dir.path);
  await pipeline.run();
  const first = column(
    dir.path,
    'SELECT itemId FROM accessRequests ORDER BY itemId',
  );
  access.feed.remove('7');

  await pipeline.run();

  assert.deepEqual(first, ['7', '8']);
  assert.deepEqual(column(dir.path, 'SELECT itemId FROM accessRequests'), [
    '8',
  ]);
  assert.deepEqual(
    column(
      dir.path,
      "SELECT count(*) FROM listItems WHERE listId = 'list-access'",
    ),
    [0],
  );
  assert.deepEqual(
    graph
      .requests()
      .filter((request) => request.includes('/lists/list-access/items/delta')),
    [],
  );
});

test('a library that SharePoint removed takes its files with it', async () => {
  await using dir = await new TemporaryFiles().directory('sharepoint-');
  const sales = salesSite();
  sales.drives.push({
    id: 'b!archive',
    name: 'Archive',
    feed: new Feed([driveFile('b!archive', 'file-old', 'Old.docx')]),
  });
  using graph = microsoft({ sites: [sales], pageSize: 200 });
  const pipeline = await warehouse(graph.source(), dir.path);
  await pipeline.run();
  const before = column(dir.path, 'SELECT name FROM driveItems ORDER BY name');
  sales.drives = sales.drives.filter(({ id }) => id !== 'b!archive');

  await pipeline.run();

  assert.deepEqual(before, ['Budget.xlsx', 'Old.docx', 'Proposals']);
  assert.deepEqual(
    column(dir.path, 'SELECT name FROM driveItems ORDER BY name'),
    ['Budget.xlsx', 'Proposals'],
  );
});

test('a pass over a large library holds one drive item at a time, so it loads in a small heap', async () => {
  await using dir = await new TemporaryFiles().directory('sharepoint-large-');
  // The import as a host runs it, in a process whose heap is far smaller
  // than the library. Graph is stubbed in that process: a drive of 60,000
  // files in pages of 200, each file with 1 KB in its URL, so a pass that
  // holds every item, or every record it loads, runs out of heap. The
  // process loads the built packages from this package's folder, where its
  // dependencies resolve.
  const pass = `
    const { Connection, Copy, Pipeline } = await import('@eltjs/elt');
    const { SQLiteCheckpointStore, SQLiteDestination, SQLiteSyncHistory } = await import('@eltjs/elt-sqlite');
    const { SharePointClient } = await import('@eltjs/sdk-microsoft-sharepoint');
    const { Msw } = await import('@zukhruf/testing/msw');
    const { http } = await import('msw');
    const { SharePointSource } = await import(process.env.SOURCE);
    const tenant = '${TENANT}';
    const site = { id: 'contoso.sharepoint.com,1,2', name: 'Sales', displayName: 'Sales', webUrl: '${SALES}', createdDateTime: '${CREATED}', lastModifiedDateTime: '${MODIFIED}' };
    const items = 60000, pageSize = 200, padding = 'x'.repeat(1000);
    const file = (n) => ({ id: 'item-' + n, name: 'photo-' + n + '.jpg', size: n, file: { mimeType: 'image/jpeg' }, parentReference: { driveId: 'drive', id: 'root', path: '/drives/drive/root:' }, webUrl: '${SALES}/Shared Documents/photo-' + n + '.jpg?' + padding, createdDateTime: '${CREATED}', lastModifiedDateTime: '${MODIFIED}', eTag: 'e' + n });
    const graph = (url) => {
      const path = decodeURIComponent(url.pathname);
      if (path.endsWith('/drives')) return Response.json({ value: [{ id: 'drive', name: 'Documents', driveType: 'documentLibrary', webUrl: '${SALES}/Shared Documents', createdDateTime: '${CREATED}', lastModifiedDateTime: '${MODIFIED}' }] });
      if (path.endsWith('/lists') || path.endsWith('/pages')) return Response.json({ value: [] });
      if (path.endsWith('/root/delta')) {
        const from = Number(url.searchParams.get('from') ?? 0);
        const value = Array.from({ length: Math.min(pageSize, items - from) }, (_, index) => file(from + index));
        const link = 'https://graph.microsoft.com/v1.0/drives/drive/root/delta?from=' + (from + pageSize);
        return Response.json(from + pageSize < items ? { value, '@odata.nextLink': link } : { value, '@odata.deltaLink': link });
      }
      return Response.json(site);
    };
    const wire = new Msw().intercept(
      http.post('https://login.microsoftonline.com/' + tenant + '/oauth2/v2.0/token', () => Response.json({ token_type: 'Bearer', access_token: 'app-token', expires_in: 3599, ext_expires_in: 3599 })),
      http.get('https://graph.microsoft.com/*', ({ request }) => graph(new URL(request.url))),
    );
    const client = new SharePointClient({ tenantId: tenant, clientId: 'client-id', clientSecret: 'client-secret', clock: globalThis });
    const source = new SharePointSource({ client, sites: ['${SALES}'] });
    const destination = new SQLiteDestination({ path: process.env.OUT + '/warehouse.sqlite' });
    const { streams } = await source.discover();
    await new Pipeline({ clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'sharepoint',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({ path: process.env.OUT + '/checkpoints.sqlite' }),
          steps: streams.map((stream) => new Copy(stream, destination.table(stream.name), {
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          })),
        }),
      ],
    }).run();
    wire.cleanup();
  `;

  const run = spawnSync(
    process.execPath,
    ['--max-old-space-size=64', '--input-type=module', '-e', pass],
    {
      cwd: join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        SOURCE: pathToFileURL(join(import.meta.dirname, 'sharepoint-source.ts'))
          .href,
        OUT: dir.path,
      },
      encoding: 'utf8',
      timeout: 300_000,
    },
  );

  // V8 names a heap limit it reached in the first lines it writes.
  assert.equal(
    run.status,
    0,
    `${run.signal ?? ''} ${run.error?.message ?? ''}\n${run.stderr.slice(0, 1000)}`,
  );
  assert.deepEqual(
    column(dir.path, 'SELECT count(*) FROM driveItems'),
    [60_000],
  );
});
