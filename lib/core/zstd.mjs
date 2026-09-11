/**
 * Zero-dependency Zstandard frame handling for DSH session logs.
 *
 * DSH appends one zstd frame per flush, so a session artifact is a *multi-frame*
 * zstd stream. Node's zstd helpers decode only the first frame, and the first
 * frame of a DSH log must contain exactly one header line — so this module walks
 * the physical frames itself (block headers only, no re-implementation of
 * compression) and compresses each frame separately.
 *
 * @module dsh-session-migration-repair/core/zstd
 */
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528;

/** Is a zstd frame magic present at `offset`? */
export function isZstdFrame(buffer, offset = 0) {
  return buffer.length - offset >= 4 && buffer.readUInt32LE(offset) === ZSTD_MAGIC;
}

/**
 * Walk the physical frame boundaries of a multi-frame zstd stream.
 * Only block headers are parsed; block payloads stay untouched.
 * @param {Buffer} buffer
 * @returns {{start: number, end: number}[]}
 */
export function listFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (!isZstdFrame(buffer, offset)) throw new Error("not a zstd stream: invalid frame magic at byte " + offset);
    offset += 4;
    if (offset >= buffer.length) throw new Error("truncated zstd frame header at byte " + start);
    // RFC 8878 numbers the Frame_Header_Descriptor bits most-significant first, so the
    // LSB-side mapping below is the reverse of the field order in the spec text.
    const descriptor = buffer.readUInt8(offset++);
    const dictionaryFlag = descriptor & 0x03;          // spec bits 7-6
    const contentChecksum = (descriptor >> 2) & 0x01;  // spec bit 5
    const unused = (descriptor >> 3) & 0x01;           // spec bit 4 (reserved, must be 0)
    const reserved = (descriptor >> 4) & 0x01;         // spec bit 3 (unused, must be 0)
    const singleSegment = (descriptor >> 5) & 0x01;    // spec bit 2
    const contentSizeFlag = (descriptor >> 6) & 0x03;  // spec bits 1-0
    if (unused !== 0 || reserved !== 0) throw new Error("corrupt zstd stream: reserved frame-header bit at byte " + (offset - 1));
    if (!singleSegment) offset += 1; // window descriptor
    offset += dictionaryFlag === 0 ? 0 : dictionaryFlag === 1 ? 1 : dictionaryFlag === 2 ? 2 : 4;
    offset += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8;
    for (;;) {
      if (offset + 3 > buffer.length) throw new Error("truncated zstd block header at byte " + offset);
      const b0 = buffer.readUInt8(offset);
      const b1 = buffer.readUInt8(offset + 1);
      const b2 = buffer.readUInt8(offset + 2);
      offset += 3;
      const lastBlock = b0 & 0x01;
      const blockType = (b0 >> 1) & 0x03;
      const blockSize = (b0 >> 3) | (b1 << 5) | (b2 << 13);
      if (blockType === 3) throw new Error("corrupt zstd stream: reserved block type at byte " + (offset - 3));
      offset += blockType === 1 ? 1 : blockSize; // RLE stores one byte
      if (offset > buffer.length) throw new Error("truncated zstd block payload at byte " + offset);
      if (lastBlock) break;
    }
    if (contentChecksum) offset += 4;
    frames.push({ start, end: offset });
  }
  return frames;
}

/** Decompress every frame and return the concatenated plaintext. */
export function decompressFrames(buffer) {
  const frames = listFrames(buffer);
  const parts = frames.map(({ start, end }) => zstdDecompressSync(buffer.subarray(start, end)));
  return Buffer.concat(parts);
}

/** Decompress a stored session artifact to text (byte-safe, single UTF-8 decode). */
export function decodeLog(buffer) {
  return decompressFrames(buffer).toString("utf8");
}

/** Decompress only the first frame — used to assert the "header line only" rule. */
export function decodeFirstFrame(buffer) {
  return zstdDecompressSync(buffer).toString("utf8");
}

/**
 * Encode text lines as a DSH-compatible multi-frame zstd stream.
 * Frame 1 holds exactly the header line (DSH rejects any other shape);
 * the remaining lines are packed in groups of `frameLines`.
 *
 * @param {string[]} lines log lines without trailing newline characters
 * @param {{frameLines?: number, level?: number}} [options]
 * @returns {Buffer}
 */
export function encodeLog(lines, options = {}) {
  if (lines.length === 0) throw new Error("cannot encode an empty log");
  const frameLines = options.frameLines ?? 500;
  const level = options.level ?? 3;
  if (!Number.isInteger(frameLines) || frameLines < 1) throw new Error("frameLines must be a positive integer");
  const frames = [zstdCompressSync(Buffer.from(lines[0] + "\n", "utf8"), { level })];
  for (let index = 1; index < lines.length; index += frameLines) {
    const chunk = lines.slice(index, index + frameLines).join("\n") + "\n";
    frames.push(zstdCompressSync(Buffer.from(chunk, "utf8"), { level }));
  }
  return Buffer.concat(frames);
}
