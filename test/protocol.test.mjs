import test from 'node:test';
import assert from 'node:assert/strict';
import { isSyntheticContext, oneLine, fingerprint } from '../lib/protocol.mjs';

test('harness-injected context is recognised', () => {
  assert.equal(isSyntheticContext('<environment_context>\n  x'), true);
  assert.equal(isSyntheticContext('Current runtime context. ...'), true);
  assert.equal(isSyntheticContext('<system-reminder>\nA skill'), true);
  assert.equal(isSyntheticContext('帮我把这个改成深色主题'), false);
});

test('previews are flattened and trimmed', () => {
  assert.equal(oneLine('a\n\n b   c', 20), 'a b c');
  assert.equal(oneLine('x'.repeat(50), 10).length, 10);
});

test('fingerprint is stable and short', () => {
  const a = fingerprint({ id: 'x', createdAt: 1 }, 'hello');
  assert.equal(a, fingerprint({ id: 'x', createdAt: 1 }, 'hello'));
  assert.notEqual(a, fingerprint({ id: 'x', createdAt: 2 }, 'hello'));
  assert.equal(a.length, 16);
});
