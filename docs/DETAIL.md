# Session bridge

Moves one coding-agent conversation at a time **in either direction** between
DeepSeek Harness and Codex. Open it from the icon at the bottom of the sidebar.

## The frame

1. **Choose a direction** — `Codex → DeepSeek Harness` or `DeepSeek Harness → Codex`.
2. **Browse the source the way that agent groups itself**:
   - Codex: its real project list (`projects` / `project_roots`), by working
     directory, with a trailing *未分组* bucket for anything unmatched.
   - DSH: its workspace registry, in sidebar order.
   Click a project to expand its conversations.
3. **Inspect one conversation** — turn / message / tool-call counts and the
   opening exchange, plus the target working directory.
4. **Import** — creates one new session in the other harness. Nothing existing
   is rewritten.

A DSH target must be an existing **workspace**, not an arbitrary folder: DSH
renders its sidebar from the Workspace registry (`workspace.json`), not from a
directory scan, and validates membership as `realpath(header.cwd) === workspace.path`.
The panel therefore offers a workspace picker, writes the log at that path, and
registers the session id in the registry. The session appears after DSH restarts.

## What each direction writes

| Direction | Writes | Safety |
|---|---|---|
| Codex → DSH | a new `session.v4.jsonl.zstd` under `~/.dsh/sessions` | new directory only |
| DSH → Codex | a rollout under `~/.codex/sessions/YYYY/MM/DD/` **and** one new row in `state_N.sqlite` | copies the index database to `*.asb-backup-<ts>` first; `INSERT` only, never `UPDATE` |

Both directions record the transfer in `~/.dsh/session-bridge/migrations.json`,
so the same conversation reports as already migrated instead of being copied
twice. `force` overrides that deliberately.

## Adapting to new versions

DSH publishes required event fields in
`<install>/docs/persistence-schema.json`; they are read at runtime, not
hard-coded, and the panel warns when the installed schema no longer matches
`schema/baseline.json`. On the Codex side, a schema or layout change degrades to
a listed-but-untitled session instead of a silent failure.

## Extending to another agent

Drop a module into `lib/adapters/local/` exporting `id`, `label`, `writes`,
`scan(options)`, `read(file)` and optionally `write(events, options)`. It is
picked up on the next start.

## Limitations

- A new session appears in the target app's sidebar only after that app
  restarts, because both list sessions at startup.
- Codex rows written by this plugin carry `source: vscode` and
  `model_provider: openai` because those columns are `NOT NULL` and only accept
  the values Codex itself writes; the conversation content is the imported one.
- Reasoning and tool records convert. Metadata with no counterpart in the other
  format is dropped rather than approximated.
