import { type FormEvent, useState } from 'react';

export function EditableList({
  label,
  items,
  placeholder,
  type,
  disabled,
  onChange,
}: {
  label: string;
  items: readonly string[];
  placeholder: string;
  type: 'url' | 'text';
  disabled: boolean;
  onChange: (items: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = (event: FormEvent) => {
    event.preventDefault();
    const item = draft.trim();
    if (item !== '' && !items.includes(item)) {
      onChange([...items, item]);
    }
    setDraft('');
  };
  return (
    <section className="editable">
      <h2>{label}</h2>
      <form onSubmit={add}>
        <input
          type={type}
          value={draft}
          placeholder={placeholder}
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={disabled || draft.trim() === ''}>
          Add
        </button>
      </form>
      <ul>
        {items.map((item) => (
          <li key={item}>
            <span title={item}>{item}</span>
            <button
              type="button"
              className="remove"
              aria-label={`Remove ${item}`}
              disabled={disabled}
              onClick={() => onChange(items.filter((other) => other !== item))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
