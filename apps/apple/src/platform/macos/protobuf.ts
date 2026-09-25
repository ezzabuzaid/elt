// The Protocol Buffers wire format, read without a schema: Notes ships none we
// can load, so callers address fields by number.
type Field =
  | {
      readonly number: number;
      readonly wire: 0 | 1 | 5;
      readonly value: bigint;
    }
  | { readonly number: number; readonly wire: 2; readonly value: Uint8Array };

export class ProtobufMessage {
  readonly #fields: Field[] = [];

  constructor(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    let offset = 0;
    const varint = () => {
      let value = 0n;
      for (let shift = 0n; ; shift += 7n) {
        if (offset >= bytes.length || shift > 63n)
          throw new TypeError('Truncated protobuf varint');
        const byte = bytes[offset++] as number;
        value |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return value;
      }
    };
    while (offset < bytes.length) {
      const key = Number(varint());
      const number = key >>> 3;
      const wire = key & 7;
      if (number === 0) throw new TypeError('Invalid protobuf field number 0');
      if (wire === 0) this.#fields.push({ number, wire, value: varint() });
      else if (wire === 1 || wire === 5) {
        const size = wire === 1 ? 8 : 4;
        if (offset + size > bytes.length)
          throw new TypeError('Truncated protobuf fixed field');
        const value =
          wire === 1
            ? view.getBigUint64(offset, true)
            : BigInt(view.getUint32(offset, true));
        this.#fields.push({ number, wire, value });
        offset += size;
      } else if (wire === 2) {
        const length = Number(varint());
        if (offset + length > bytes.length)
          throw new TypeError('Truncated protobuf length-delimited field');
        this.#fields.push({
          number,
          wire,
          value: bytes.subarray(offset, offset + length),
        });
        offset += length;
      } else throw new TypeError(`Unsupported protobuf wire type ${wire}`);
    }
  }

  #all(number: number): Field[] {
    return this.#fields.filter((field) => field.number === number);
  }

  // Protobuf's rule for a repeated scalar read as singular: the last one wins.
  #last(number: number): Field | undefined {
    return this.#all(number).at(-1);
  }

  has(number: number): boolean {
    return this.#last(number) !== undefined;
  }

  uint(number: number): number | undefined {
    const field = this.#last(number);
    if (field === undefined) return undefined;
    if (field.wire !== 0)
      throw new TypeError(`Protobuf field ${number} is not a varint`);
    if (field.value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new TypeError(`Protobuf field ${number} exceeds a safe integer`);
    return Number(field.value);
  }

  float(number: number): number | undefined {
    const field = this.#last(number);
    if (field === undefined) return undefined;
    if (field.wire !== 5)
      throw new TypeError(`Protobuf field ${number} is not a float`);
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, Number(field.value), true);
    return view.getFloat32(0, true);
  }

  bytes(number: number): Uint8Array | undefined {
    const field = this.#last(number);
    return field === undefined ? undefined : this.#delimited(field, number);
  }

  string(number: number): string | undefined {
    const bytes = this.bytes(number);
    return bytes === undefined
      ? undefined
      : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  message(number: number): ProtobufMessage | undefined {
    const bytes = this.bytes(number);
    return bytes === undefined ? undefined : new ProtobufMessage(bytes);
  }

  bytesList(number: number): Uint8Array[] {
    return this.#all(number).map((field) => this.#delimited(field, number));
  }

  messages(number: number): ProtobufMessage[] {
    return this.bytesList(number).map((bytes) => new ProtobufMessage(bytes));
  }

  strings(number: number): string[] {
    return this.bytesList(number).map((bytes) =>
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  }

  #delimited(field: Field, number: number): Uint8Array {
    if (field.wire !== 2)
      throw new TypeError(`Protobuf field ${number} is not length-delimited`);
    return field.value;
  }
}
