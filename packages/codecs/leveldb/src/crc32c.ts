// CRC-32C (Castagnoli) as LevelDB stores it: masked, so the checksum of data
// that itself holds checksums is not a fixed point.
// https://github.com/google/leveldb/blob/7ee830d02b623e8ffe0b95d59a74db1e58da04c5/util/crc32c.h#L22-L38
const table = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++)
    crc = crc & 1 ? 0x82f63b78 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

export function maskedCrc32c(...parts: readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts)
    for (const byte of part)
      crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}
