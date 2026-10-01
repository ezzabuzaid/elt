// A lossless RFC 5545 content-line parser: it keeps every property, parameter
// and vendor extension, and leaves property values raw (no TEXT unescaping), so
// any value type round-trips unchanged.

export type ICalParameter = {
  readonly name: string;
  readonly values: readonly string[];
};

export type ICalProperty = {
  readonly name: string;
  readonly parameters: readonly ICalParameter[];
  readonly value: string;
};

export type ICalComponent = {
  readonly name: string;
  readonly properties: readonly ICalProperty[];
  readonly components: readonly ICalComponent[];
};

type Building = {
  name: string;
  properties: ICalProperty[];
  components: Building[];
};

const namePattern = /^[A-Za-z0-9-]+/;

export function parseICalendar(bytes: Uint8Array): ICalComponent {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(unfold(bytes));
  } catch (cause) {
    throw new TypeError('iCalendar data is not valid UTF-8', { cause });
  }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const stack: Building[] = [];
  let root: Building | undefined;
  for (const [index, line] of lines.entries()) {
    const fail = (reason: string) =>
      new TypeError(`iCalendar line ${index + 1}: ${reason}`);
    if (root !== undefined && stack.length === 0)
      throw fail('content after the calendar ended');
    const property = parseLine(line, fail);
    if (property.name === 'BEGIN') {
      const component: Building = {
        name: property.value.toUpperCase(),
        properties: [],
        components: [],
      };
      if (!namePattern.test(component.name))
        throw fail(`invalid component name ${property.value}`);
      const parent = stack.at(-1);
      if (parent === undefined) {
        if (component.name !== 'VCALENDAR')
          throw fail('content must start with BEGIN:VCALENDAR');
        root = component;
      } else parent.components.push(component);
      stack.push(component);
    } else if (property.name === 'END') {
      const open = stack.pop();
      if (open === undefined || open.name !== property.value.toUpperCase())
        throw fail(
          `END:${property.value} does not close ${open?.name ?? 'anything'}`,
        );
    } else {
      const open = stack.at(-1);
      if (open === undefined) throw fail('property outside a component');
      open.properties.push(property);
    }
  }
  if (root === undefined)
    throw new TypeError('iCalendar data has no VCALENDAR');
  if (stack.length > 0)
    throw new TypeError(
      `iCalendar component ${stack.at(-1)?.name} is not closed`,
    );
  return freeze(root);
}

// Folding inserts CRLF (or a bare LF) plus one space or tab, possibly inside a
// multi-byte character, so it is removed before decoding.
function unfold(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    const lf =
      byte === 0x0d && bytes[index + 1] === 0x0a
        ? index + 1
        : byte === 0x0a
          ? index
          : -1;
    const next = lf === -1 ? undefined : bytes[lf + 1];
    if (next === 0x20 || next === 0x09) {
      index = lf + 1;
      continue;
    }
    out[length++] = byte as number;
  }
  return out.subarray(0, length);
}

function parseLine(
  line: string,
  fail: (reason: string) => TypeError,
): ICalProperty {
  const name = namePattern.exec(line)?.[0];
  if (name === undefined) throw fail('missing property name');
  let position = name.length;
  const parameters: ICalParameter[] = [];
  while (line[position] === ';') {
    const parameterName = namePattern.exec(line.slice(position + 1))?.[0];
    if (
      parameterName === undefined ||
      line[position + 1 + parameterName.length] !== '='
    )
      throw fail(`invalid parameter in ${name}`);
    position += parameterName.length + 2;
    const values: string[] = [];
    for (;;) {
      let value: string;
      if (line[position] === '"') {
        const end = line.indexOf('"', position + 1);
        if (end === -1) throw fail(`unterminated quoted parameter in ${name}`);
        value = line.slice(position + 1, end);
        position = end + 1;
      } else {
        const end = line.slice(position).search(/[";:,]/);
        const stop = end === -1 ? line.length : position + end;
        if (line[stop] === '"') throw fail(`misplaced quote in ${name}`);
        value = line.slice(position, stop);
        position = stop;
      }
      values.push(decodeCaret(value));
      if (line[position] !== ',') break;
      position++;
    }
    parameters.push({ name: parameterName.toUpperCase(), values });
  }
  if (line[position] !== ':') throw fail(`missing colon after ${name}`);
  return {
    name: name.toUpperCase(),
    parameters,
    value: line.slice(position + 1),
  };
}

// RFC 6868: ^n is a newline, ^' a double quote, ^^ a caret; other carets stay.
function decodeCaret(value: string): string {
  return value.replaceAll(/\^([n'^])/g, (_, code: string) =>
    code === 'n' ? '\n' : code === "'" ? '"' : '^',
  );
}

function freeze(component: Building): ICalComponent {
  return Object.freeze({
    name: component.name,
    properties: Object.freeze(
      component.properties.map((property) =>
        Object.freeze({
          ...property,
          parameters: Object.freeze(
            property.parameters.map((parameter) =>
              Object.freeze({
                ...parameter,
                values: Object.freeze(parameter.values),
              }),
            ),
          ),
        }),
      ),
    ),
    components: Object.freeze(component.components.map(freeze)),
  });
}
