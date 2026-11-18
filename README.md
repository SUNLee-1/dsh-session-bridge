# dsh-session-bridge

Move one coding-agent conversation at a time between **DeepSeek Harness** and
**Codex** — in either direction — without touching a single existing session.

DeepSeek Harness is the control center: it shows the Codex sidebar exactly as
Codex itself renders it, and writes the Codex-side records only after taking a
backup.

```
┌ Session bridge ───────────────────────────────────────────┐
│  Choose a direction                                       │
│  ┌───────────────────────┐ ┌───────────────────────┐      │
│  │ Codex → DSH           │ │ DSH → Codex           │      │
│  └───────────────────────┘ └───────────────────────┘      │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌ projects (as the source agent groups them) │ conversation ┐
│ 作品相关（portfolio）                  0 │ 11 messages    │
│ UNISEE账号运营                        1 │ 29 tool calls  │
│ 杂项                                  6 │ 2 turns        │
│ 论文+毕设专家助理                       5 │                │
│ LibTV Plugin                          9 │ target folder  │
│ 飞书+UIUX                              4 │ [ 开始导入 ]    │
└────────────────────────────────────────────┴────────────────┘
```

## Why it is not just another converter

**It mirrors each harness instead of guessing.** Codex does not group its
sidebar by working directory. It persists the layout in
`.codex-global-state.json` (`project-order`, `local-projects`,
`thread-project-assignments`, `sidebar-project-thread-orders`,
`projectless-thread-ids`), and it hides its own internal review threads
(`thread_source = guardian_review`). Reading those keys is the difference between
104 mixed rows and the 28 conversations you actually see.

**It follows DSH's schema instead of hard-coding it.** Required fields for every
session event are resolved at runtime from
`<install>/docs/persistence-schema.json`, and `schema/baseline.json` records the
digest this build was written against. `asb drift` reports a change.

**It stays small.** No dependencies, no build step, ~3k lines. A session is
streamed source → writer; transcripts are never buffered whole.

| Operation | Cost |
|---|---|
| Plugin resident memory | ≈ 6 MB |
| Listing 110 Codex rollouts (1.3 GB, largest 299 MB) | ≈ 30–110 ms, +25 MB transient |
| Repeat listing (3 s TTL cache) | 0 ms |
| Importing a 101-event conversation | 110 KB log, 2 zstd frames |

## The bridge inbox

On first activation the plugin creates **one folder that is both a DSH Workspace
and a Codex Project**, so migrations have a predictable home instead of landing
wherever the source folder happened to be:

| | |
|---|---|
| Folder | `~/Session Bridge` (same real path on both sides) |
| DSH | Workspace titled *Session Bridge* |
| Codex | Project titled *Session Bridge*, first in the sidebar |

Every import targets it by default, and the panel marks it **互通收件箱 / Bridge
inbox**. Creation is idempotent, backs up the Codex index and UI state, and never
touches existing projects.

Change it in `cordis.patch.yml`:

```yaml
config:
  bridge:
    enabled: true
    path: '~/Documents/My Bridge'   # empty = "<home>/Session Bridge"
    name: 'My Bridge'
```

Or from the CLI: `node bin/asb.mjs init --path "~/Documents/My Bridge" --name "My Bridge"`
(quit DSH first, or run `session_bridge action=init` from inside it).

## Install

### As a DeepSeek Harness plugin (gives you the panel)

Requires **DeepSeek Harness** and Node **22.0+** (bundled runtime is fine).

```bash
git clone https://github.com/YOUR_GITHUB_NAME/dsh-session-bridge.git
```

Then in DSH: **Plugins → Add plugin → local directory**, and pick the cloned
folder. Or from an agent session:

```
plugin_manager  action: install_bundle
target: /absolute/path/to/dsh-session-bridge
```

Restart DSH once; the sidebar gains a **会话互通 / Session bridge** icon.

### As a CLI (works without DSH)

```bash
node bin/asb.mjs doctor          # what this machine can do
node bin/asb.mjs list            # every session, grouped by project
node bin/asb.mjs migrate --from codex --id <session-id> --to dsh --cwd /target
node bin/asb.mjs verify <session.v4.jsonl.zstd>
```

Encoding or decoding DSH logs needs zstd. Either run inside DSH (its Electron
runtime has it), or use Node ≥ 22.15. On an older Node the CLI shells out to the
installed DSH binary automatically; `doctor` reports which path is in use.

### As an MCP server (for Codex, Claude Code, any MCP client)

```json
{
  "mcpServers": {
    "session-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/dsh-session-bridge/mcp/server.mjs"]
    }
  }
}
```

Tools: `session_bridge_list`, `session_bridge_migrate`, `session_bridge_verify`,
`session_bridge_drift`.

## Platform support

| | Linux | macOS | Windows |
|---|---|---|---|
| DSH plugin (Host + panel) | ✅ | ✅ | ✅ |
| CLI (read/write with DSH present) | ✅ | ✅ | ✅ |
| MCP server | ✅ | ✅ | ✅ |
| Paths are discovered, never assumed | `DSH_INSTALL_DIR`, `process.resourcesPath`, per-platform defaults | | |

Overrides: `DSH_HOME`, `CODEX_HOME`, `DSH_INSTALL_DIR`, `ASB_NODE`.

## What a migration writes

| Direction | Created | Never touched |
|---|---|---|
| Codex → DSH | one new `session.v4.jsonl.zstd` under `~/.dsh/sessions/<project>/<id>/` | every existing session |
| DSH → Codex | one rollout under `~/.codex/sessions/YYYY/MM/DD/`, one new row in `state_N.sqlite`, one membership entry in `.codex-global-state.json` | every existing row, rollout and project |

Codex-side writes copy `state_N.sqlite` and `.codex-global-state.json` to
`*.asb-backup-<timestamp>` first, keep only the newest three backups, and use
`INSERT` only. Every import is recorded in
`~/.dsh/session-bridge/migrations.json`, so repeating one reports `duplicate`
instead of copying the conversation twice.

## What DSH will not accept

A session can be structurally perfect and still be rejected on load. The writer
satisfies the three invariants DSH's validator enforces:

- a `tool/call` must be advertised as a `tool-call` block of an `assistant/message`
- a step must not end with an advertised call unresolved (a source session
  without a result gets an explicit isError result saying so)
- turns are `1..n` and steps are `1..n` inside each turn; source numbering is
  discarded and renumbered

`asb verify` runs DSH's own `assertReleasedV4Relationships`, so a bad log is
caught before you ever open it.

## Extending to another agent

Drop a module into `lib/adapters/local/` — see
[lib/adapters/local/README.md](lib/adapters/local/README.md). Adapters are
discovered at startup; no core edit, no build step.

## Development

```bash
node --test          # 9 tests, no dependencies
node bin/asb.mjs doctor
```

## Known limitations

- **A DSH target must be an existing workspace.** DSH builds its sidebar from the
  Workspace registry, not from a directory scan, and rejects a session whose
  `cwd` is not a workspace path. The panel lists workspaces for this reason; a
  custom path that is not a workspace will produce an invisible session.
- A newly written session appears in the target app's sidebar only after that
  app restarts; both harnesses read their registries at startup.
- Codex's `source` / `model_provider` columns are `NOT NULL` and only accept
  values Codex itself writes, so imported rows carry `vscode` / `openai`. The
  conversation content is the imported one.
- Metadata that has no counterpart in the target format is dropped, not
  approximated.

## License

MIT — see [LICENSE](LICENSE).
