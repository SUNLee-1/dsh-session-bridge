import test from 'node:test';
import assert from 'node:assert/strict';
import { projectKey, projectDirName, encodeSegment } from '../lib/dsh-path.mjs';

test('projectKey matches the layout DSH writes on disk', () => {
  // Verified against 20 real session directories on a reference machine.
  assert.equal(
    projectDirName('/Users/sunlijunzhe/Desktop/deepseek文件暂存/多agent互通'),
    '--Users-sunlijunzhe-Desktop-deepseek~6587~4EF6~6682~5B58-~591Aagent~4E92~901A--',
  );
  assert.equal(
    projectDirName('/Users/larr/Research_Assistant/【1019】比选文件'),
    '--Users-larr-Research_Assistant-~30101019~3011~6BD4~9009~6587~4EF6--',
  );
});

test('projectKey collapses separators and falls back to root', () => {
  assert.equal(projectKey('/a//b///c'), 'a-b-c');
  assert.equal(projectKey('///'), 'root');
  assert.equal(projectKey('C:\\Users\\x'), 'C-Users-x');
});

test('encodeSegment keeps safe ids and encodes the rest', () => {
  assert.equal(encodeSegment('session-6cb77151-bca6-4783-9588-67912520d75f'), 'session-6cb77151-bca6-4783-9588-67912520d75f');
  assert.equal(encodeSegment('a/b'), 'a~002Fb');
  assert.notEqual(encodeSegment('..'), '..');
});
