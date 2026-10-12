import { useState } from 'react';

import { messageOf } from './call-tool.ts';
import { ChoiceGroup } from './choice-group.tsx';
import { ConfirmDialog } from './confirm-dialog.tsx';
import type { Update } from './connector-switch.tsx';
import type {
  ConnectorChoices,
  ConnectorRow,
  ConnectorSelection,
} from './contract.ts';
import { dayOf, endAfterDay, lastDayBefore, startOfDay } from './local-days.ts';

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

export function ScopeForm({
  row,
  choices,
  onUpdate,
}: {
  row: ConnectorRow;
  choices: ConnectorChoices;
  onUpdate: Update;
}) {
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
      await onUpdate(row.name, saved);
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
