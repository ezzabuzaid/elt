import * as Select from '@radix-ui/react-select';
import { useEffect, useState } from 'react';

import { callTool, messageOf } from './call-tool.ts';
import { type TranscriptionChoices, transcriptionResult } from './contract.ts';
import { usePage } from './page-context.tsx';

export function TranscriptionDetail() {
  const { app } = usePage();
  const [choices, setChoices] = useState<TranscriptionChoices | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (app === null) return;
    const read = new AbortController();
    callTool(app, 'apple_transcription', {}, transcriptionResult).then(
      (result) => {
        if (!read.signal.aborted) setChoices(result);
      },
      (error: unknown) => {
        if (!read.signal.aborted) setFailure(messageOf(error));
      },
    );
    return () => read.abort();
  }, [app]);
  return (
    <main className="page">
      <h2>Audio transcription</h2>
      {failure !== null && (
        <p role="alert" className="text-destructive">
          {failure}
        </p>
      )}
      {choices === null && failure === null && (
        <p className="text-muted">Finding installed models…</p>
      )}
      {choices !== null && <TranscriptionForm choices={choices} />}
    </main>
  );
}

function TranscriptionForm({ choices }: { choices: TranscriptionChoices }) {
  const { app } = usePage();
  const [saved, setSaved] = useState(choices.selected);
  const selected = choices.models.find(
    ({ configuration }) =>
      configuration.engine === saved?.engine &&
      configuration.directory === saved.directory,
  );
  const [enabled, setEnabled] = useState(choices.selected !== null);
  const [model, setModel] = useState(
    selected?.id ?? choices.models[0]?.id ?? '',
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const save = async () => {
    if (app === null) return;
    setSaving(true);
    setFailure(null);
    setMessage(null);
    try {
      const result = await callTool(
        app,
        'apple_transcription_update',
        { model: enabled ? model : null },
        transcriptionResult,
      );
      setSaved(result.selected);
      setMessage(
        enabled
          ? 'Saved. Audio in your imports will be transcribed in the background.'
          : 'Transcription is off. Existing transcripts are kept.',
      );
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="card scope"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="transcription-toggle">
        <span>Transcribe audio</span>
        <input
          className="switch"
          type="checkbox"
          role="switch"
          checked={enabled}
          disabled={saving || (choices.models.length === 0 && !enabled)}
          onChange={(event) => {
            setEnabled(event.target.checked);
            setMessage(null);
          }}
        />
      </label>
      {choices.models.length === 0 ? (
        <p className="text-muted">
          No supported model is installed. Download Cohere or Canary in Handy,
          then reopen this page.
        </p>
      ) : (
        <div className="transcription-model">
          <label htmlFor="transcription-model">Model</label>
          <Select.Root
            value={model}
            disabled={!enabled || saving}
            onValueChange={(value) => {
              setModel(value);
              setMessage(null);
            }}
          >
            <Select.Trigger id="transcription-model" className="form-select">
              <Select.Value />
            </Select.Trigger>
            <Select.Portal>
              <Select.Content
                className="menu transcription-menu"
                position="popper"
                sideOffset={4}
                collisionPadding={6}
              >
                <Select.Viewport>
                  {choices.models.map(({ id, title }) => (
                    <Select.Item key={id} value={id} className="menu-item">
                      <Select.ItemIndicator className="transcription-selected">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="m5 12 4 4L19 6" />
                        </svg>
                      </Select.ItemIndicator>
                      <Select.ItemText>
                        {title} · installed in Handy
                      </Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        </div>
      )}
      {saved !== null && selected === undefined && (
        <p className="text-muted">
          The saved model is no longer installed. Choose another model or turn
          transcription off.
        </p>
      )}
      <p className="text-small text-muted">
        Runs on this Mac. Uses audio from the attachments included in your
        imports. Saving transcribes existing audio and new audio on each sync.
      </p>
      {failure !== null && (
        <p role="alert" className="text-small text-destructive">
          {failure}
        </p>
      )}
      {message !== null && (
        <p role="status" className="text-small">
          {message}
        </p>
      )}
      <div className="actions">
        <button
          className="btn btn-primary"
          type="submit"
          disabled={
            saving ||
            app === null ||
            (enabled ? model === '' || model === selected?.id : saved === null)
          }
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
