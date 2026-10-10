// A number as pass.json spells it. An issuer may write a value no double
// holds exactly, such as a long membership number or a balance, so its text
// is kept.
export class PassNumber {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

export type PassJson =
  | string
  | boolean
  | null
  | PassNumber
  | readonly PassJson[]
  | { readonly [key: string]: PassJson };

// JSON whose numbers keep their text: JSON.parse hands its reviver the source
// of each value.
export function parsePassJson(text: string): PassJson {
  return passJson(
    JSON.parse(
      text,
      (_key: string, value: unknown, context?: { readonly source?: string }) =>
        typeof value === 'number' && context?.source !== undefined
          ? new PassNumber(context.source)
          : value,
    ),
  );
}

// JSON text of a value, each number as pass.json spelled it.
export function passJsonText(value: PassJson): string {
  if (value instanceof PassNumber) return value.text;
  if (isPassList(value)) return `[${value.map(passJsonText).join(',')}]`;
  if (isPassObject(value))
    return `{${Object.entries(value)
      .map(([key, field]) => `${JSON.stringify(key)}:${passJsonText(field)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function isPassObject(
  value: PassJson | undefined,
): value is { readonly [key: string]: PassJson } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof PassNumber)
  );
}

export function isPassList(
  value: PassJson | undefined,
): value is readonly PassJson[] {
  return Array.isArray(value);
}

function passJson(value: unknown): PassJson {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    value instanceof PassNumber
  )
    return value;
  if (Array.isArray(value)) return value.map(passJson);
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, passJson(field)]),
    );
  throw new TypeError(`JSON parsing returned a ${typeof value}`);
}
