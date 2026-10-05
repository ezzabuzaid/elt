import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// packages/codecs/protobuf/dist/protobuf.js
var ProtobufMessage = class _ProtobufMessage {
  #fields = [];
  constructor(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    let offset = 0;
    const varint = () => {
      let value = 0n;
      for (let shift = 0n; ; shift += 7n) {
        const byte = bytes[offset++];
        if (byte === void 0 || shift > 63n)
          throw new TypeError("Truncated protobuf varint");
        value |= BigInt(byte & 127) << shift;
        if ((byte & 128) === 0)
          return value;
      }
    };
    while (offset < bytes.length) {
      const key = Number(varint());
      const number = key >>> 3;
      const wire = key & 7;
      if (number === 0)
        throw new TypeError("Invalid protobuf field number 0");
      if (wire === 0)
        this.#fields.push({ number, wire, value: varint() });
      else if (wire === 1 || wire === 5) {
        const size = wire === 1 ? 8 : 4;
        if (offset + size > bytes.length)
          throw new TypeError("Truncated protobuf fixed field");
        const value = wire === 1 ? view.getBigUint64(offset, true) : BigInt(view.getUint32(offset, true));
        this.#fields.push({ number, wire, value });
        offset += size;
      } else if (wire === 2) {
        const length = Number(varint());
        if (offset + length > bytes.length)
          throw new TypeError("Truncated protobuf length-delimited field");
        this.#fields.push({
          number,
          wire,
          value: bytes.subarray(offset, offset + length)
        });
        offset += length;
      } else
        throw new TypeError(`Unsupported protobuf wire type ${wire}`);
    }
  }
  #all(number) {
    return this.#fields.filter((field) => field.number === number);
  }
  // Protobuf's rule for a repeated scalar read as singular: the last one wins.
  #last(number) {
    return this.#all(number).at(-1);
  }
  has(number) {
    return this.#last(number) !== void 0;
  }
  uint(number) {
    const field = this.#last(number);
    if (field === void 0)
      return void 0;
    if (field.wire !== 0)
      throw new TypeError(`Protobuf field ${number} is not a varint`);
    if (field.value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new TypeError(`Protobuf field ${number} exceeds a safe integer`);
    return Number(field.value);
  }
  // An int64 field: negative values arrive as ten-byte two's complement.
  int(number) {
    const field = this.#last(number);
    if (field === void 0)
      return void 0;
    if (field.wire !== 0)
      throw new TypeError(`Protobuf field ${number} is not a varint`);
    const value = BigInt.asIntN(64, field.value);
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
      throw new TypeError(`Protobuf field ${number} exceeds a safe integer`);
    return Number(value);
  }
  float(number) {
    const field = this.#last(number);
    if (field === void 0)
      return void 0;
    if (field.wire !== 5)
      throw new TypeError(`Protobuf field ${number} is not a float`);
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, Number(field.value), true);
    return view.getFloat32(0, true);
  }
  double(number) {
    const field = this.#last(number);
    if (field === void 0)
      return void 0;
    if (field.wire !== 1)
      throw new TypeError(`Protobuf field ${number} is not a double`);
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, field.value, true);
    return view.getFloat64(0, true);
  }
  bytes(number) {
    const field = this.#last(number);
    return field === void 0 ? void 0 : this.#delimited(field, number);
  }
  string(number) {
    const bytes = this.bytes(number);
    return bytes === void 0 ? void 0 : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  message(number) {
    const bytes = this.bytes(number);
    return bytes === void 0 ? void 0 : new _ProtobufMessage(bytes);
  }
  bytesList(number) {
    return this.#all(number).map((field) => this.#delimited(field, number));
  }
  messages(number) {
    return this.bytesList(number).map((bytes) => new _ProtobufMessage(bytes));
  }
  strings(number) {
    return this.bytesList(number).map((bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  #delimited(field, number) {
    if (field.wire !== 2)
      throw new TypeError(`Protobuf field ${number} is not length-delimited`);
    return field.value;
  }
};

export {
  ProtobufMessage
};
