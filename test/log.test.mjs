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
  // A complete turn: DSH's semantic validator rejects a log that leaves a turn
  // or step open, so the fixture has to be a whole turn, not a fragment.
  const events = [
    JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
    JSON.stringify({ type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } }),
    JSON.stringify({
      type: 'user/message',
      seq: 2,
      time: 3,
      data: { content: [{ type: 'text', text: 'hi' }], role: 'user', id: 'm1', source: { kind: 'user' } },
      surfaceOp: 'append',
    }),
    JSON.stringify({ type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } }),
    JSON.stringify({ type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } }),
  ];
  const writer = new SessionLogWriter(file);
  writer.writeHeader(header);
  for (const event of events) writer.writeEvent(event);
  const frames = writer.close();

  assert.ok(frames >= 2, 'header frame plus at least one event frame');

  const lines = [];
  for await (const line of iterLogLines(file)) lines.push(line);
  assert.equal(lines.length, 6);
  assert.equal(lines[0], header);

  const result = await verifyDshLog(file);
  assert.equal(result.ok, true);
  assert.equal(result.events, 5);
  fs.rmSync(dir, { recursive: true, force: true });
});
