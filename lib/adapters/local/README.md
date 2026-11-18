# Local adapters

Drop an `.mjs` file here to teach the bridge another agent's session store. It is
picked up on the next start; nothing in the core needs editing.

An adapter is a module exporting:

```js
export const id = 'myagent';       // short, unique, shown in the panel
export const label = 'My Agent';   // display name
export const writes = 'direct';    // 'direct' = can be a target, 'read-only' = source only

/** List this agent's sessions. Keep it cheap: no transcript parsing. */
export async function scan({ home } = {}) {
  return [{
    adapter: id,
    id: 'session-id',
    path: '/absolute/path/to/session-file',
    title: 'shown in the list',
    cwd: '/absolute/working/directory',
    model: '',
    createdAt: 0,
    updatedAt: 0,
    bytes: 0,
  }];
}

/** Stream one session as canonical events (see lib/protocol.mjs). */
export async function* read(file) {
  yield { k: 'meta', id: 'session-id', cwd: '/work', createdAt: 0, model: 'x' };
  yield { k: 'user', at: Date.now(), turn: 1, step: 1, text: 'hello' };
  yield { k: 'assistant', at: Date.now(), turn: 1, step: 1, text: 'hi' };
}

/** Optional: accept an import. Required only when `writes === 'direct'`. */
export async function write(events, { cwd, title, createdAt }) {
  return { file: '/path/written', events: 0, bytes: 0 };
}
```

Rules that keep the tool honest:

- `scan()` must never load a whole transcript; read a bounded prefix for titles.
- `read()` must yield events lazily so a 300 MB session never becomes a buffer.
- `write()` must only create new records, and must back up any index it touches.

The canonical event kinds are declared in `lib/protocol.mjs`:
`meta`, `title`, `turn/start`, `turn/end`, `step/start`, `step/end`, `user`,
`assistant`, `tool/call`, `tool/result`, `usage`.
