import { useState } from 'react';

import type { ConnectorChoices } from './contract.ts';

// Long lists, such as Messages' chats, get a filter.
const filterFrom = 12;

// One kind of choice, such as accounts or folders: the ids picked, where all
// of them means the connector is not narrowed by this kind.
export function ChoiceGroup({
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
