/**
 * Migration engine shared by the DSH plugin, the CLI and the MCP server.
 *
 * Memory contract: a session is streamed from a source adapter straight into a
 * target adapter. No full transcript is buffered, and nothing is copied twice —
 * a completed migration is recorded in a ledger so the same conversation is not
 * imported again.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { installDir } from './install.mjs';
import { fingerprint } from './protocol.mjs';
import * as codex from './adapters/codex.mjs';
import * as dsh from './adapters/dsh.mjs';
import { codexProjects, codexSidebar, dshProjects, groupSessions } from './projects.mjs';

/** Built-in adapters. Add one by dropping a module into `adapters/local/`. */
const BUILT_IN = [codex, dsh];

const ADAPTER_API = ['id', 'label', 'read', 'scan'];

/**
 * Resolve the adapter set, including any operator-supplied adapters.
 * A local adapter is a module exporting id/label/scan/read (+ optional write)
 * with the same shape as the built-ins.
 * @param {string} [localDir]
 */
export async function loadAdapters(localDir = new URL('./adapters/local/', import.meta.url)) {
  const map = new Map(BUILT_IN.map((a) => [a.id, a]));
  let entries = [];
  try {
    entries = fs.readdirSync(localDir).filter((n) => n.endsWith('.mjs'));
  } catch {
    entries = [];
  }
  for (const name of entries) {
    try {
      const mod = await import(new URL(name, localDir).href);
      if (!ADAPTER_API.every((key) => mod[key] !== undefined)) continue;
      map.set(mod.id, mod);
    } catch {
      // A broken optional adapter must not take the bridge down.
    }
  }
  return map;
}

/** @param {{home?:string}} [options] */
export async function listAll(options = {}) {
  const adapters = await loadAdapters();
  const rows = [];
  for (const adapter of adapters.values()) {
    try {
      rows.push(...(await adapter.scan(options)));
    } catch {
      // One unreadable store must not hide the others.
    }
  }
  return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/**
 * Sessions grouped the way each harness groups them: Codex by working
 * directory with its named project roots, DSH by workspace registry order.
 * @param {{home?:string}} [options]
 */
let treeCache = { at: 0, value: undefined };

/** Drop the cached tree so the next read reflects a just-finished write. */
export function invalidateTree() {
  treeCache = { at: 0, value: undefined };
}

export async function tree(options = {}) {
  // The panel and the tool both call this; a short TTL avoids re-scanning two
  // session stores when a user clicks around.
  if (treeCache.value && Date.now() - treeCache.at < 3000) return treeCache.value;
  const rows = await listAll(options);
  const projects = {
    codex: codexProjects(options.codexHome),
    dsh: dshProjects(options.dshHome),
  };
  const groups = {};
  // Codex has a persisted sidebar layout; mirror it when it is readable and
  // fall back to working-directory grouping only when it is not.
  groups.codex =
    codexSidebar(options.codexHome ?? path.join(os.homedir(), '.codex'), rows) ??
    groupSessions(rows.filter((row) => row.adapter === 'codex'), projects.codex, '未分组 / Ungrouped');
  groups.dsh = groupSessions(rows.filter((row) => row.adapter === 'dsh'), projects.dsh, '未分组 / Ungrouped');
  const value = { rows, groups, summary: summarize(rows) };
  treeCache = { at: Date.now(), value };
  return value;
}

/**
 * Bounded preview of one session: counts and the opening exchange only.
 * @param {{adapter:string, sessionId:string, home?:string, limit?:number}} input
 */
export async function preview(input) {
  const adapters = await loadAdapters();
  const adapter = adapters.get(input.adapter);
  if (!adapter) throw new Error(`unknown adapter: ${input.adapter}`);
  const rows = await adapter.scan(input);
  const row = rows.find((item) => item.id === input.sessionId);
  if (!row) throw new Error(`session ${input.sessionId} not found`);

  let messages = 0;
  let assistants = 0;
  let toolCalls = 0;
  let turns = 0;
  let firstUser = '';
  let lastAssistant = '';
  const opening = [];
  for await (const event of adapter.read(row.path)) {
    if (event.k === 'user') {
      messages += 1;
      if (!firstUser) firstUser = event.text;
      if (opening.length < 3) opening.push({ role: 'user', text: event.text.slice(0, 300) });
    } else if (event.k === 'assistant') {
      assistants += 1;
      if (event.text) lastAssistant = event.text;
      if (event.text && opening.length < 3) opening.push({ role: 'assistant', text: event.text.slice(0, 300) });
    } else if (event.k === 'tool/call') {
      toolCalls += 1;
    } else if (event.k === 'turn/start') {
      turns += 1;
    }
  }
  return {
    adapter: adapter.id,
    label: adapter.label,
    sessionId: row.id,
    title: row.title,
    cwd: row.cwd,
    bytes: row.bytes,
    updatedAt: row.updatedAt,
    messages,
    assistants,
    toolCalls,
    turns,
    firstUser: firstUser.slice(0, 400),
    lastAssistant: lastAssistant.slice(0, 400),
    opening,
  };
}

/** Byte totals per adapter, for the panel's summary line. */
export function summarize(rows) {
  const byAdapter = new Map();
  for (const row of rows) {
    const entry = byAdapter.get(row.adapter) ?? { adapter: row.adapter, sessions: 0, bytes: 0 };
    entry.sessions += 1;
    entry.bytes += row.bytes ?? 0;
    byAdapter.set(row.adapter, entry);
  }
  return [...byAdapter.values()].sort((a, b) => a.adapter.localeCompare(b.adapter));
}

/** @param {string} [home] DSH home override */
export function ledgerPath(home = process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh')) {
  return path.join(home, 'session-bridge', 'migrations.json');
}

export function readLedger(file = ledgerPath()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { version: 1, entries: [] };
  }
}

export function writeLedger(ledger, file = ledgerPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
}

/** A short, stable key for "this same conversation". */
export function keyOf(row, firstUserText = '') {
  return fingerprint({ id: row?.title ?? row?.id, createdAt: row?.createdAt ?? 0 }, firstUserText);
}

/**
 * Migrate one session, streaming source -> target.
 * @param {object} input
 * @param {string} input.adapter source adapter id
 * @param {string} input.sessionId source session id
 * @param {string} input.to target adapter id
 * @param {string} [input.cwd] target working directory (defaults to source cwd)
 * @param {boolean} [input.dryRun]
 * @param {string} [input.home]
 */
export async function migrate(input) {
  const adapters = await loadAdapters();
  const source = adapters.get(input.adapter);
  const target = adapters.get(input.to);
  if (!source) throw new Error(`unknown source adapter: ${input.adapter}`);
  if (!target) throw new Error(`unknown target adapter: ${input.to}`);
  if (target.writes !== 'direct') {
    return {
      ok: false,
      reason: `${target.label} is read-only by design; its adapter does not write into that store`,
    };
  }

  const sessions = await source.scan(input);
  const item = sessions.find((row) => row.id === input.sessionId);
  if (!item) throw new Error(`session ${input.sessionId} not found in ${source.label}`);

  const ledger = readLedger();
  const already = ledger.entries.find(
    (entry) => entry.from === input.adapter && entry.fromId === item.id && entry.to === input.to,
  );
  if (already && !input.force) {
    return { ok: false, duplicate: true, reason: `already migrated to ${target.label}`, previous: already };
  }

  // A DSH target must live at a workspace path, or the session can never be
  // accounted and will stay invisible. workspacePath therefore wins.
  const cwd = input.workspacePath || input.cwd || item.cwd;
  if (!cwd) throw new Error('target working directory is unknown; pass cwd explicitly');

  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      from: { adapter: source.id, id: item.id, title: item.title, bytes: item.bytes },
      to: { adapter: target.id, cwd },
    };
  }

  const written = await target.write(source.read(item.path), {
    cwd,
    title: item.title,
    createdAt: item.createdAt,
    mode: input.mode,
  });

  ledger.entries.unshift({
    from: source.id,
    fromId: item.id,
    fromPath: item.path,
    to: target.id,
    toId: written.sessionId ?? written.file,
    toPath: written.file,
    at: new Date().toISOString(),
    events: written.events,
    bytes: written.bytes,
  });
  ledger.entries = ledger.entries.slice(0, 500);
  writeLedger(ledger);
  invalidateTree();

  return { ok: true, from: { adapter: source.id, id: item.id, title: item.title }, to: written };
}

let validatorCache;

/**
 * DSH's own semantic relationships check. It is the only thing that catches
 * cross-event invariants such as "a tool/call must have been advertised by an
 * assistant message", so verification uses it whenever the install is readable.
 */
async function dshValidator() {
  if (validatorCache !== undefined) return validatorCache;
  const base = installDir();
  if (!base) {
    validatorCache = undefined;
    return undefined;
  }
  try {
    const v34 = await import(pathToFileURL(path.join(base, '..', 'dsh-session-format-v3-to-v4', 'lib', 'index.js')).href);
    const session = await import(pathToFileURL(path.join(base, '..', 'dsh-session', 'lib', 'index.js')).href);
    validatorCache = { assert: v34.assertReleasedV4Relationships, known: session.KNOWN_SESSION_EVENT_TYPES };
    return validatorCache;
  } catch {
    validatorCache = undefined;
    return undefined;
  }
}

/**
 * Structural verification of a written DSH log, without loading it whole.
 * @param {string} file
 */
export async function verifyDshLog(file) {
  const { iterLogLines } = await import('./zstd.mjs');
  let header;
  let expected = 0;
  const collected = [];
  const problems = [];
  for await (const line of iterLogLines(file)) {
    if (!header) {
      header = JSON.parse(line);
      if (header.type !== 'session') problems.push('first line is not a session header');
      if (header.version !== dsh.FORMAT_VERSION) problems.push(`unexpected version ${header.version}`);
      continue;
    }
    const event = JSON.parse(line);
    if (event.seq !== expected) problems.push(`seq ${event.seq} where ${expected} was expected`);
    expected = event.seq + 1;
    collected.push(event);
  }
  if (!header) problems.push('empty log');

  const validator = await dshValidator();
  let semantic = validator ? 'checked' : 'unavailable';
  if (validator && problems.length === 0) {
    try {
      validator.assert({ header, events: collected, inheritedEventCount: 0 }, validator.known);
    } catch (error) {
      semantic = 'failed';
      problems.push(String(error?.message ?? error).slice(0, 300));
    }
  }
  return { ok: problems.length === 0, problems: problems.slice(0, 5), events: collected.length, semantic, header };
}

export { codex, dsh };
