const decoder = new TextDecoder('utf-8', { fatal: true });
const stringClass = new TextEncoder().encode('NSString');
const cString = 0x2b; // '+', typedstream's type code for a byte string
// typedstream integer tags: the next 2 or 4 bytes hold the value, little-endian.
const int16 = 0x81;
const int32 = 0x82;

// Messages archives a message body as an NSAttributedString in NeXT typedstream
// form. Its plain text is the first NSString: after the class name and version,
// a '+' type code, a length, then that many UTF-8 bytes.
export function attributedText(body: Uint8Array): string | null {
  const name = indexOf(body, stringClass);
  if (name === -1) return null;
  const type = body.indexOf(cString, name + stringClass.length);
  if (type === -1 || type > name + stringClass.length + 8)
    throw new TypeError('attributedBody has no string after NSString');
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let offset = type + 1;
  let length = body[offset] ?? -1;
  offset += 1;
  if (length === int16) {
    length = view.getUint16(offset, true);
    offset += 2;
  } else if (length === int32) {
    length = view.getUint32(offset, true);
    offset += 4;
  }
  if (length < 0 || offset + length > body.length)
    throw new TypeError('attributedBody string runs past its end');
  return decoder.decode(body.subarray(offset, offset + length));
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  const first = needle[0] as number;
  for (
    let start = haystack.indexOf(first);
    start !== -1 && start + needle.length <= haystack.length;
    start = haystack.indexOf(first, start + 1)
  )
    if (needle.every((byte, index) => haystack[start + index] === byte))
      return start;
  return -1;
}
