import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSessions } from '../lib/projects.mjs';

test('sessions are bucketed by exact working directory', () => {
  const groups = groupSessions(
    [
      { id: 'a', cwd: '/p/one', updatedAt: 2 },
      { id: 'b', cwd: '/p/one', updatedAt: 1 },
      { id: 'c', cwd: '/elsewhere', updatedAt: 3 },
    ],
    [
      { id: '1', label: 'One', path: '/p/one' },
      { id: '2', label: 'Two', path: '/p/two' },
    ],
    'Ungrouped',
  );
  assert.deepEqual(groups.map((group) => group.label), ['One', 'Ungrouped']);
  assert.deepEqual(groups[0].sessions.map((row) => row.id), ['a', 'b']);
  assert.deepEqual(groups[1].sessions.map((row) => row.id), ['c']);
});

test('duplicate project roots do not double count', () => {
  const groups = groupSessions(
    [{ id: 'a', cwd: '/p', updatedAt: 1 }],
    [
      { id: '1', label: 'One', path: '/p' },
      { id: '2', label: 'Two', path: '/p' },
    ],
    'Ungrouped',
  );
  assert.equal(groups.reduce((sum, group) => sum + group.sessions.length, 0), 1);
});
