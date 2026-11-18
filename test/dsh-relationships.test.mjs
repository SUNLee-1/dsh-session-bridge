import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasNativeZstd, iterLogLines } from '../lib/zstd.mjs';
import { installDir } from '../lib/install.mjs';
import * as dsh from '../lib/adapters/dsh.mjs';

const base = installDir();
const skip = !hasNativeZstd()
  ? 'needs native zstd'
  : !base
    ? 'needs a DeepSeek Harness install to load its validator'
    : false;

async function validator() {
  const v34 = await import(pathToFileURL(path.join(base, '..', 'dsh-session-format-v3-to-v4', 'lib', 'index.js')).href);
  const session = await import(pathToFileURL(path.join(base, '..', 'dsh-session', 'lib', 'index.js')).href);
  return { assert: v34.assertReleasedV4Relationships, known: session.KNOWN_SESSION_EVENT_TYPES };
}

async function readLog(file) {
  let header;
  const events = [];
  for await (const line of iterLogLines(file)) {
    if (!header) header = JSON.parse(line);
    else events.push(JSON.parse(line));
  }
  return { header, events };
}

/**
 * These are the invariants DSH enforces on load and the ones a naive writer
 * misses: a tool/call must be advertised by an assistant message, a step must
 * not end with an unresolved call, and turns/steps must number 1..n.
 */
test('a written log satisfies DSH relationship invariants', { skip }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-rel-'));
  const cwd = path.join(home, 'bridge');
  const at = Date.now();
  async function* events() {
    yield { k: 'turn/start', at, turn: 1 };
    yield { k: 'user', at, turn: 1, step: 1, text: 'first' };
    yield { k: 'assistant', at, turn: 1, step: 1, text: 'running a tool' };
    yield { k: 'tool/call', at, turn: 1, step: 1, callId: 'a1', name: 'bash', arguments: '{}' };
    yield { k: 'tool/result', at, turn: 1, step: 1, callId: 'a1', output: 'ok' };
    // Advertised and started, but the source has no result: must be repaired.
    yield { k: 'tool/call', at, turn: 1, step: 1, callId: 'a2', name: 'bash', arguments: '{}' };
    yield { k: 'step/end', at, turn: 1, step: 1 };
    // A second step inside the same turn exercises per-turn step numbering.
    yield { k: 'step/start', at, turn: 1, step: 2 };
    yield { k: 'assistant', at, turn: 1, step: 2, text: 'second step of turn 1' };
    yield { k: 'step/end', at, turn: 1, step: 2 };
    yield { k: 'turn/end', at, turn: 1, reason: 'completed' };
    yield { k: 'turn/start', at, turn: 2 };
    yield { k: 'user', at, turn: 2, step: 1, text: 'second' };
    yield { k: 'assistant', at, turn: 2, step: 1, text: 'done' };
    yield { k: 'turn/end', at, turn: 2, reason: 'completed' };
  }

  const written = await dsh.write(events(), { cwd, home, title: 'relationship test' });
  const { header, events: log } = await readLog(written.file);

  const turns = log.filter((e) => e.type === 'turn/start').map((e) => e.data.turn);
  assert.deepEqual(turns, [1, 2], 'turns are renumbered from 1');
  const steps = log.filter((e) => e.type === 'step/start').map((e) => e.data.step);
  assert.deepEqual(steps, [1, 2, 1], 'steps number 1..n per turn and restart after it');
  const repaired = log.filter((e) => e.type === 'tool/result' && e.data.message.toolCallId === 'a2');
  assert.equal(repaired.length, 1, 'the unresolved call is closed with an explicit result');

  const { assert: check, known } = await validator();
  check({ header, events: log, inheritedEventCount: 0 }, known);

  fs.rmSync(home, { recursive: true, force: true });
});
