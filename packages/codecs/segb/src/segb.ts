import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

// SEGB v2, the segment files Biome appends protobuf records to: a 32-byte
// header whose int32 at byte 4 counts the slots, the records from byte 32, and
// at the end of the file one 16-byte trailer slot per record, slot k at
// size − 16·(k+1). Records follow one another in slot order, each on a
// four-byte boundary: a CRC-32 of its payload, an int32, then the payload.
// After CCL Forensics' reader,
// https://github.com/cclgroupltd/ccl-segb/blob/23c3f7d3d969a79627b738ba0a2486c31d675753/ccl_segb/ccl_segb2.py

const headerLength = 32;
const entryHeaderLength = 8;
const slotLength = 16;
const appleEpoch = Date.UTC(2001, 0, 1);

export class SegbFormatError extends Error {
  override name = 'SegbFormatError';

  constructor(path: string, problem: string) {
    super(`${path} is not a SEGB v2 file: ${problem}`);
  }
}

export type SegbState = 'written' | 'deleted';

export type SegbRecord = {
  // The record's trailer slot, 0 for the first record of the file. Biome never
  // compacts a file, so the slot addresses the record for as long as it exists.
  readonly slot: number;
  readonly state: SegbState;
  readonly writtenAt: Date;
  // Null unless the record is written and its checksum matches: Biome zeroes
  // a deleted record in place, and some slots marked written hold zeroes.
  readonly payload: Uint8Array | null;
};

// Trailer slot states; 4 marks a slot with no record.
const states = new Map<number, SegbState>([
  [1, 'written'],
  [3, 'deleted'],
]);

// What identifies a file's records without reading them: a hash of its
// trailer, which changes with every record Biome appends or deletes. Biome
// preallocates each file and writes in place, so the file's size and
// modification time do not, and the header's deletion counter drifts.
export async function segbFingerprint(path: string): Promise<string> {
  await using file = await open(path);
  const header = new Uint8Array(headerLength);
  const { size } = await file.stat();
  await file.read(header, 0, headerLength, 0);
  const count = slotCount(path, header, size);
  const trailer = new Uint8Array(count * slotLength);
  await file.read(trailer, 0, trailer.length, size - trailer.length);
  return createHash('sha256').update(trailer).digest('base64url');
}

// Every record the trailer lists, in slot order.
export async function readSegb(path: string): Promise<SegbRecord[]> {
  const bytes = await readFile(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const count = slotCount(path, bytes, bytes.length);
  const trailer = bytes.length - count * slotLength;
  const records: SegbRecord[] = [];
  let start = headerLength;
  for (let slot = 0; slot < count; slot++) {
    const at = bytes.length - slotLength * (slot + 1);
    const end = headerLength + view.getInt32(at, true);
    const state = states.get(view.getInt32(at + 4, true));
    if (end > trailer)
      throw new SegbFormatError(path, `slot ${slot} ends inside the trailer`);
    if (state !== undefined) {
      const data =
        end - start >= entryHeaderLength
          ? bytes.subarray(start + entryHeaderLength, end)
          : null;
      records.push({
        slot,
        state,
        writtenAt: new Date(appleEpoch + view.getFloat64(at + 8, true) * 1000),
        payload:
          state === 'written' &&
          data !== null &&
          crc32(data) === view.getUint32(start, true)
            ? data
            : null,
      });
    }
    // Records start on four-byte boundaries.
    if (end > start) start = end + ((4 - (end % 4)) % 4);
  }
  return records;
}

function slotCount(path: string, header: Uint8Array, size: number): number {
  if (
    size < headerLength ||
    new TextDecoder('latin1').decode(header.subarray(0, 4)) !== 'SEGB'
  )
    throw new SegbFormatError(path, 'no SEGB header');
  const count = new DataView(
    header.buffer,
    header.byteOffset,
    header.length,
  ).getInt32(4, true);
  if (count < 0 || headerLength + count * slotLength > size)
    throw new SegbFormatError(path, `a trailer of ${count} slots does not fit`);
  return count;
}
