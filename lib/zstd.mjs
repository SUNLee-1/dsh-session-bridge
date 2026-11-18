/**
 * Streaming Zstandard frame codec for DSH session logs.
 *
 * DSH stores a session log as a concatenation of independent zstd frames:
 *   frame 1  = exactly one header line (ending in "\n")
 *   frame 2+ = event lines
 *
 * Memory contract for this module: a session is never held in memory whole.
 * Frame boundaries are found with positioned reads (block headers are skipped
 * by seeking), and frames are decoded one at a time. Writers emit one frame per
 * flushed chunk, so both directions stay proportional to the largest chunk.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { electronBinary } from './install.mjs';

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_c_checksumFlag = 201;
const CHUNK_BYTES = 1 << 20;

export function hasNativeZstd() {
  return (
    typeof zlib.zstdCompressSync === 'function' &&
    typeof zlib.zstdDecompressSync === 'function'
  );
}

/**
 * Decode a whole log in one child process of the DSH runtime.
 * Used only when the host Node has no native zstd; spawning per frame would
 * cost one process per append chunk. `maxBytes` bounds a metadata probe.
 * @param {string} file
 * @param {number} maxBytes
 */
export function decodePrefix(file, maxBytes) {
  return childDecodeFile(file, maxBytes);
}

function childDecodeFile(file, maxBytes = Number.MAX_SAFE_INTEGER) {
  const binary = electronBinary();
  if (!binary) {
    throw new Error(
      'No native zstd in this Node runtime and the DeepSeek Harness app was not found. ' +
        'Run inside DSH, or use Node >= 22.15.',
    );
  }
  const script = `
const fs = require('node:fs'), z = require('node:zlib');
const file = process.argv[1], max = Number(process.argv[2]);
const buf = fs.readFileSync(file);
let p = 0, written = 0;
while (p < buf.length && written < max) {
  if (buf.readUInt32LE(p) !== 0xfd2fb528) throw new Error('bad zstd magic at ' + p);
  const fhd = buf[p + 4];
  const fcs = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1;
  let q = p + 5;
  if (!single) q += 1;
  q += [0, 1, 2, 4][fhd & 3];
  q += fcs === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcs];
  for (;;) {
    const header = buf[q] | (buf[q + 1] << 8) | (buf[q + 2] << 16);
    q += 3;
    const last = header & 1, type = (header >> 1) & 3, size = header >>> 3;
    if (type === 3) throw new Error('reserved block type');
    q += type === 1 ? 1 : size;
    if (last) break;
  }
  if (checksum) q += 4;
  const text = z.zstdDecompressSync(buf.subarray(p, q)).toString('utf8');
  const room = max - written;
  const slice = text.length > room ? text.slice(0, room) : text;
  process.stdout.write(slice);
  written += slice.length;
  p = q;
}
`;
  return execFileSync(binary, ['-e', script, '--', file, String(maxBytes)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    maxBuffer: Math.max(16 << 20, Math.min(maxBytes + (1 << 20), 512 << 20)),
  }).toString('utf8');
}

/** Compress one chunk through the DSH runtime when the host Node lacks zstd. */
function childCompress(text) {
  const binary = electronBinary();
  if (!binary) {
    throw new Error('Writing a session needs native zstd: run inside DSH or on Node >= 22.15.');
  }
  const script = `
const z = require('node:zlib');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  process.stdout.write(z.zstdCompressSync(Buffer.concat(chunks), { params: { [${ZSTD_c_checksumFlag}]: 1 } }));
});
`;
  return execFileSync(binary, ['-e', script], {
    input: Buffer.from(text, 'utf8'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    maxBuffer: 256 << 20,
  });
}

export function decompressFrame(frame) {
  return zlib.zstdDecompressSync(frame).toString('utf8');
}

export function compressFrame(text) {
  const raw = Buffer.from(text, 'utf8');
  if (!hasNativeZstd()) return childCompress(text);
  try {
    return zlib.zstdCompressSync(raw, { params: { [ZSTD_c_checksumFlag]: 1 } });
  } catch {
    return zlib.zstdCompressSync(raw);
  }
}

/** Byte range of the frame that starts at `start`. */
function frameEnd(fd, start, fileSize) {
  const head = Buffer.alloc(1);
  const read = (buf, position) => fs.readSync(fd, buf, 0, buf.length, position);
  if (read(head, start + 4) !== 1) throw new Error(`truncated zstd frame header at ${start}`);
  const fhd = head[0];
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const checksumFlag = (fhd >> 2) & 1;
  let p = start + 5;
  if (!singleSegment) p += 1;
  p += [0, 1, 2, 4][fhd & 3];
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  const blockHeader = Buffer.alloc(3);
  for (;;) {
    if (p + 3 > fileSize) throw new Error(`truncated zstd block header at ${p}`);
    read(blockHeader, p);
    const header = blockHeader[0] | (blockHeader[1] << 8) | (blockHeader[2] << 16);
    p += 3;
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >>> 3;
    if (type === 3) throw new Error(`reserved zstd block type at ${p - 3}`);
    p += type === 1 ? 1 : size;
    if (last) break;
  }
  if (checksumFlag) p += 4;
  if (p > fileSize) throw new Error(`truncated zstd frame at ${start}`);
  return p;
}

/**
 * Yield one decoded payload string per frame without loading the file.
 * @param {string} file
 * @returns {AsyncGenerator<string>}
 */
export async function* iterFramePayloads(file) {
  if (!hasNativeZstd()) {
    yield childDecodeFile(file);
    return;
  }
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let p = 0;
    const magic = Buffer.alloc(4);
    while (p < size) {
      if (p + 4 > size) throw new Error(`truncated zstd frame header at ${p}`);
      fs.readSync(fd, magic, 0, 4, p);
      if (magic.readUInt32LE(0) !== ZSTD_MAGIC) throw new Error(`expected zstd frame magic at ${p}`);
      const end = frameEnd(fd, p, size);
      const frame = Buffer.alloc(end - p);
      fs.readSync(fd, frame, 0, frame.length, p);
      yield decompressFrame(frame);
      p = end;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Yield the log's lines one at a time. Only the current frame is resident.
 * @param {string} file
 * @returns {AsyncGenerator<string>}
 */
export async function* iterLogLines(file) {
  let carry = '';
  for await (const payload of iterFramePayloads(file)) {
    const text = carry + payload;
    const parts = text.split('\n');
    carry = parts.pop() ?? '';
    for (const line of parts) {
      if (line.length > 0) yield line;
    }
  }
  if (carry.length > 0) yield carry;
}

/**
 * Append-only session log writer. Frame 1 is written on the first call, and
 * every flushed chunk becomes one more frame — the layout DSH expects.
 */
export class SessionLogWriter {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
    this.buffer = [];
    this.bytes = 0;
    this.frames = 0;
    this.fd = fs.openSync(file, 'w');
    try {
      // POSIX permissions; Windows ignores mode bits, so never fail on them.
      fs.chmodSync(file, 0o600);
    } catch {
      // The file is still written with the platform default protection.
    }
  }

  /** @param {string} line */
  writeHeader(line) {
    fs.writeSync(this.fd, compressFrame(`${line}\n`));
    this.frames += 1;
  }

  /** @param {string} line */
  writeEvent(line) {
    this.buffer.push(line);
    this.bytes += line.length + 1;
    if (this.bytes >= CHUNK_BYTES) this.flush();
  }

  flush() {
    if (this.buffer.length === 0) return;
    fs.writeSync(this.fd, compressFrame(`${this.buffer.join('\n')}\n`));
    this.frames += 1;
    this.buffer = [];
    this.bytes = 0;
  }

  close() {
    this.flush();
    fs.closeSync(this.fd);
    return this.frames;
  }
}
