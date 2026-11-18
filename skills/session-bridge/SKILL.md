---
name: session-bridge
description: Move one coding-agent conversation between DeepSeek Harness and another agent (Codex). Use when the user asks to continue a conversation started in another agent, to import/迁移/互通/搬一个会话, or to check whether a session format changed.
---

# Session bridge

DeepSeek Harness is the control center. A session is migrated one at a time, on
request; nothing is migrated in bulk and nothing existing is rewritten.

## Decide which surface to use

1. **Panel** — the sidebar icon labelled 会话互通 / Session bridge. Best for a
   human picking a conversation by title. Lists every session with a filter box.
2. **Tool** — `session_bridge` with `action: list | migrate | verify | drift`.
   Best when you already know which conversation, or when the user asked you to
   do it.
3. **CLI** — `node <bundle>/bin/asb.mjs list|migrate|verify|drift`. Best for
   scripts and CI.
4. **MCP** — `node <bundle>/mcp/server.mjs` as a stdio server, for another agent
   (Codex, Claude Code) that should drive the same engine.

## Do it

Both directions are supported: Codex → DSH and DSH → Codex. Imports land in the
shared **bridge inbox** (one folder that is both a DSH Workspace and a Codex
Project) unless the user picks another target. `action: init` creates or repairs
that inbox on both sides.

1. `session_bridge` `action: list`, then match the user's description to one row
   by title and `cwd`. Confirm the match when two rows are close.
2. `action: preview` with `adapter` and `sessionId`: check turn/message/tool
   counts before moving anything. If the counts look wrong, stop.
3. `action: migrate` with `adapter` (source), `sessionId`, `to` (target), and
   `cwd` — the target working directory decides which project it lands in.
4. `action: verify` on the returned `file` when the target is DSH. Report the
   event count; report `backup` when the target is Codex.
5. Tell the user to restart the target app before the session shows in its
   sidebar.

## Rules

- Writing to Codex backs its index database up first (`*.asb-backup-<ts>`) and
  only ever inserts one row. Say where the backup is.
- Never migrate in bulk or in the background: one conversation, on request.
- A migration imports a conversation's content: messages, reasoning, tool calls
  and their results, turn/step structure, title and working directory. Metadata
  that has no counterpart in the target format is dropped, not approximated.
- Harness-injected user messages (`<environment_context>`, `Current runtime
  context.`, …) are filtered out so the import does not duplicate runtime noise.
- Re-running the same migration reports `duplicate` from the ledger instead of
  writing a second copy. `force` overrides that deliberately.
- If `action: drift` reports anything but `match`, say so: the installed DSH
  session schema moved, and the plugin is following the new schema. Verify one
  import before relying on it.
