import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasNativeZstd, SessionLogWriter, iterLogLines } from '../lib/zstd.mjs';
import { verifyDshLog } from '../lib/engine.mjs';

const skip = hasNativeZstd() ? false : 'needs native zstd (Node >= 22.15, or the DSH runtime)';

test('a written log round-trips and verifies', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-'));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const header = JSON.stringify({ type: 'session', version: 4, id: 'session-1', createdAt: 1, cwd: '/tmp', isSeeded: false, delegationDepth: 0 });
  const events = [
    JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
    JSON.stringify({ type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'hi' }] }, surfaceOp: 'append' }),
  ];
  const writer = new SessionLogWriter(file);
  writer.writeHeader(header);
  for (const event of events) writer.writeEvent(event);
  const frames = writer.close();

  assert.ok(frames >= 2, 'header frame plus at least one event frame');

  const lines = [];
  for await (const line of iterLogLines(file)) lines.push(line);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], header);

  const result = await verifyDshLog(file);
  assert.equal(result.ok, true);
  assert.equal(result.events, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
