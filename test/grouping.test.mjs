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
  // Empty projects are kept on purpose: a project is also a migration
  // destination, and the bridge inbox starts empty.
  assert.deepEqual(groups.map((group) => group.label).sort(), ['One', 'Two', 'Ungrouped']);
  const one = groups.find((group) => group.label === 'One');
  const loose = groups.find((group) => group.label === 'Ungrouped');
  assert.equal(one.sessions.length, 2);
  assert.equal(loose.sessions.length, 1);
  assert.deepEqual(one.sessions.map((row) => row.id), ['a', 'b']);
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
