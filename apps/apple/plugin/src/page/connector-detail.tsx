import { type ReactNode, useEffect, useState } from 'react';

import { callTool, messageOf } from './call-tool.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { ConnectorStatus } from './connector-status.tsx';
import { ConnectorSwitch } from './connector-switch.tsx';
import {
  type ConnectorChoices,
  type ConnectorRow,
  type ConnectorSelection,
  choicesResult,
} from './contract.ts';
import { usePage } from './page-context.tsx';

// One connector: its switch, its status and what it imports. Its choices are
// read from its Apple app only when this page opens, since reading them may
// make macOS ask for access.
export function ConnectorDetail({ row }: { row: ConnectorRow }) {
  const { app, open } = usePage();
  const [choices, setChoices] = useState<ConnectorChoices | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (app === null) return;
    const read = new AbortController();
    callTool(
      app,
      'apple_connector_choices',
      { connector: row.name },
      choicesResult,
    ).then(
      (result) => {
        if (!read.signal.aborted) setChoices(result);
      },
      (error: unknown) => {
        if (!read.signal.aborted) setFailure(messageOf(error));
      },
    );
    return () => read.abort();
  }, [app, row.name]);

  let whatToImport: ReactNode;
  if (failure !== null) {
    whatToImport = (
      <p role="alert" className="text-small text-destructive">
        {failure}
      </p>
    );
  } else if (choices === null) {
    whatToImport = (
      <p className="text-small text-muted">
        Reading {row.title}’s accounts and collections. macOS may ask for
        access.
      </p>
    );
  } else {
    whatToImport = (
      <ScopeForm
        key={JSON.stringify(row.selection)}
        row={row}
        choices={choices}
      />
    );
  }

  return (
    <main className="page">
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => open(null)}
      >
        ‹ Connectors
      </button>
      <header className="header detail">
        <h2>{row.title}</h2>
        <ConnectorSwitch row={row} />
      </header>
      <ConnectorStatus row={row} />
      <section className="card">
        <h3>What to import</h3>
        {whatToImport}
      </section>
    </main>
  );
}

type Kind = ConnectorChoices['choices'][number]['scope'];

// What a connector imports, as the user edits it. Each kind of choice holds
// the ids picked; the dates stay the instants stored until the user edits a
// day, so an unedited Calendar range is no change.
type Draft = {
  readonly groups: readonly (ConnectorChoices['choices'][number] & {
    readonly picked: readonly string[];
  })[];
  readonly startAt: string | undefined;
  readonly endAt: string | undefined;
  readonly includeAttachments: boolean;
};

function draftOf(
  selection: ConnectorSelection,
  choices: ConnectorChoices,
): Draft {
  return {
    groups: choices.choices.map((choice) => ({
      ...choice,
      // A kind the selection leaves out is not narrowed: every option.
      picked:
        selection.scope[choice.scope] ?? choice.options.map(({ id }) => id),
    })),
    startAt: selection.scope.startAt,
    endAt: selection.scope.endAt,
    includeAttachments: selection.includeAttachments,
  };
}

// The selection a draft saves, or why it cannot be saved. Picking every
// option of a kind leaves the kind out, so the import is not narrowed by it.
function selectionOf(draft: Draft): ConnectorSelection | string {
  const empty = draft.groups.find(({ picked }) => picked.length === 0);
  if (empty !== undefined) return `Choose at least one of the ${empty.title}.`;
  if (
    draft.startAt !== undefined &&
    draft.endAt !== undefined &&
    draft.startAt >= draft.endAt
  )
    return 'The first day must come before the last day.';
  const narrowed = (kind: Kind) =>
    draft.groups
      .find(
        ({ scope, picked, options }) =>
          scope === kind && picked.length < options.length,
      )
      ?.picked.toSorted();
  return {
    scope: {
      accountIds: narrowed('accountIds'),
      collectionIds: narrowed('collectionIds'),
      startAt: draft.startAt,
      endAt: draft.endAt,
    },
    includeAttachments: draft.includeAttachments,
  };
}

const same = (a: ConnectorSelection | null, b: ConnectorSelection) =>
  a !== null && JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

const sorted = ({ scope, includeAttachments }: ConnectorSelection) => ({
  accountIds: scope.accountIds?.toSorted(),
  collectionIds: scope.collectionIds?.toSorted(),
  startAt: scope.startAt,
  endAt: scope.endAt,
  includeAttachments,
});

// Date inputs hold the user's local days; a selection holds UTC instants with
// an exclusive end, so the last day the user picks is included.
const pad = (value: number) => String(value).padStart(2, '0');

function dayOf(instant: string): string {
  const date = new Date(instant);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const lastDayBefore = (end: string) =>
  dayOf(new Date(Date.parse(end) - 1).toISOString());

const startOfDay = (day: string) => new Date(`${day}T00:00:00`).toISOString();

function endAfterDay(day: string): string {
  const date = new Date(`${day}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return date.toISOString();
}

function ScopeForm({
  row,
  choices,
}: {
  row: ConnectorRow;
  choices: ConnectorChoices;
}) {
  const { update } = usePage();
  const initial = row.selection ?? choices.defaultSelection;
  const [draft, setDraft] = useState(() => draftOf(initial, choices));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const selection = selectionOf(draft);
  const connected = row.selection !== null;
  const changed =
    typeof selection !== 'string' && !same(row.selection, selection);

  const save = async (saved: ConnectorSelection) => {
    setBusy(true);
    try {
      await update(row.name, saved);
      setFailure(null);
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="scope"
      onSubmit={(event) => {
        event.preventDefault();
        if (typeof selection === 'string') return;
        if (connected) setConfirming(true);
        else void save(selection);
      }}
    >
      {choices.note !== undefined && (
        <p className="text-small text-muted">{choices.note}</p>
      )}
      {draft.groups.map((group, index) => (
        <ChoiceGroup
          key={group.scope}
          choice={group}
          picked={group.picked}
          onChange={(picked) =>
            setDraft({
              ...draft,
              groups: draft.groups.with(index, { ...group, picked }),
            })
          }
        />
      ))}
      {choices.datedBy !== null && (
        <fieldset className="choice">
          <legend>Dates</legend>
          <p className="text-small text-muted">By {choices.datedBy}.</p>
          <div className="dates">
            <label>
              <span className="form-label">From</span>
              <input
                type="date"
                className="form-control"
                value={draft.startAt === undefined ? '' : dayOf(draft.startAt)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    startAt:
                      event.target.value === ''
                        ? undefined
                        : startOfDay(event.target.value),
                  })
                }
              />
            </label>
            <label>
              <span className="form-label">Until</span>
              <input
                type="date"
                className="form-control"
                value={
                  draft.endAt === undefined ? '' : lastDayBefore(draft.endAt)
                }
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    endAt:
                      event.target.value === ''
                        ? undefined
                        : endAfterDay(event.target.value),
                  })
                }
              />
            </label>
          </div>
        </fieldset>
      )}
      <label className="form-check">
        <input
          type="checkbox"
          className="form-check-input"
          checked={draft.includeAttachments}
          onChange={() =>
            setDraft({
              ...draft,
              includeAttachments: !draft.includeAttachments,
            })
          }
        />
        <span className="form-check-label">Copy attachments</span>
      </label>
      {typeof selection === 'string' && (
        <p className="text-small text-destructive">{selection}</p>
      )}
      {failure !== null && (
        <p role="alert" className="text-small text-destructive">
          {failure}
        </p>
      )}
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => setDraft(draftOf(initial, choices))}
        >
          Discard
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={
            busy || typeof selection === 'string' || (connected && !changed)
          }
        >
          {connected ? 'Save' : 'Connect'}
        </button>
      </div>
      {confirming && typeof selection !== 'string' && (
        <ConfirmDialog
          title={`Import ${row.title} again?`}
          body={`A new selection is a new import: ${row.title}’s current copy is deleted, and it has no data until the import ends.`}
          confirm="Import again"
          onConfirm={() => {
            setConfirming(false);
            void save(selection);
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </form>
  );
}

// Long lists, such as Messages' chats, get a filter.
const filterFrom = 12;

// One kind of choice, such as accounts or folders: the ids picked, where all
// of them means the connector is not narrowed by this kind.
function ChoiceGroup({
  choice,
  picked,
  onChange,
}: {
  choice: ConnectorChoices['choices'][number];
  picked: readonly string[];
  onChange: (picked: string[]) => void;
}) {
  const [filter, setFilter] = useState('');
  const all = picked.length === choice.options.length;
  const shown = choice.options.filter(({ label }) =>
    label.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
  );
  return (
    <fieldset className="choice">
      <legend>{choice.title}</legend>
      <label className="form-check">
        <input
          type="checkbox"
          className="form-check-input"
          checked={all}
          onChange={() =>
            onChange(all ? [] : choice.options.map(({ id }) => id))
          }
        />
        <span className="form-check-label">All {choice.title}</span>
      </label>
      {choice.options.length > filterFrom && (
        <input
          type="search"
          className="form-control"
          placeholder={`Filter ${choice.title}`}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      )}
      <div className="options">
        {shown.map(({ id, label }) => (
          <label key={id} className="form-check">
            <input
              type="checkbox"
              className="form-check-input"
              checked={picked.includes(id)}
              onChange={() =>
                onChange(
                  picked.includes(id)
                    ? picked.filter((item) => item !== id)
                    : [...picked, id],
                )
              }
            />
            <span className="form-check-label">{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
