/**
 * Codex adapter (read-only by design).
 *
 * Codex records a thread as an append-only rollout under
 * ~/.codex/sessions/YYYY/MM/DD/, either plain `.jsonl` or zstd `.jsonl.zst`,
 * indexed by the `threads` table in ~/.codex/state_N.sqlite.
 *
 * Writing is opt-in: `write()` backs the index up before touching it, and only
 * ever INSERTs a new thread row. No existing row or rollout is modified.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { iterLogLines, decodePrefix, hasNativeZstd } from '../zstd.mjs';
import { K, oneLine, isSyntheticContext } from '../protocol.mjs';

export const id = 'codex';
export const label = 'Codex';
export const writes = 'direct';

const ROLLOUT = /^rollout-.*\.jsonl(\.zst)?$/;
const SCAN_LINES = 80;
/** path|mtime|size -> title/id/cwd; keeps repeat listings cheap in a long-lived host. */
const PROBE_CACHE = new Map();

export function root({ home = path.join(os.homedir(), '.codex') } = {}) {
  return home;
}

export function detect({ home } = {}) {
  return fs.existsSync(path.join(root({ home }), 'sessions'));
}

function stateDb(home) {
  try {
    const names = fs.readdirSync(home).filter((n) => /^state_\d+\.sqlite$/.test(n));
    if (names.length === 0) return undefined;
    const newest = names.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
    return path.join(home, newest);
  } catch {
    return undefined;
  }
}

/**
 * The SQLite index gives titles cheaply. It is best-effort: a locked or
 * read-only filesystem (or a future schema change) falls back to a scan.
 */
let indexCache = { key: '', map: new Map() };

function indexedThreads(home) {
  const file = stateDb(home);
  const sqlite = globalThis.process?.getBuiltinModule?.('node:sqlite');
  if (!file || !sqlite) return new Map();
  let key;
  try {
    const stat = fs.statSync(file);
    key = `${file}|${stat.mtimeMs}|${stat.size}`;
    if (indexCache.key === key) return indexCache.map;
  } catch {
    return new Map();
  }
  try {
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare('select id, title, name, cwd, model, created_at, updated_at from threads')
      .all();
    db.close();
    indexCache = { key, map: new Map(rows.map((row) => [row.id, row])) };
    return indexCache.map;
  } catch {
    return new Map();
  }
}

/** Plain and zstd rollouts both yield lines, one at a time. */
async function* linesOf(file) {
  if (file.endsWith('.zst')) {
    yield* iterLogLines(file);
    return;
  }
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) if (line.length > 0) yield line;
  } finally {
    rl.close();
    stream.destroy();
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Read a bounded prefix of the decoded text.
 * A rollout can be hundreds of megabytes with multi-megabyte lines, so listing
 * must never stream a whole file just to find a title.
 * @param {string} file
 * @param {number} maxBytes
 */
async function headText(file, maxBytes = 1048576) {
  if (!file.endsWith('.zst')) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      return buf.subarray(0, fs.readSync(fd, buf, 0, maxBytes, 0)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }
  if (!hasNativeZstd()) return decodePrefix(file, maxBytes);
  const zlib = globalThis.process?.getBuiltinModule?.('node:zlib');
  if (!zlib?.createZstdDecompress) return '';
  const stream = zlib.createZstdDecompress();
  const source = fs.createReadStream(file);
  source.pipe(stream);
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) break;
    }
  } catch {
    return '';
  } finally {
    source.destroy();
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

/**
 * Cheap metadata from a bounded window: enough to title a thread, never the
 * whole transcript.
 */
async function probe(file) {
  const stat = fs.statSync(file);
  const key = `${file}|${stat.mtimeMs}|${stat.size}`;
  const memo = PROBE_CACHE.get(key);
  if (memo) return memo;
  let meta;
  let title = '';
  const head = await headText(file);
  const lines = head.split('\n');
  if (lines.length > 1) lines.pop(); // drop the likely-truncated final line
  for (const line of lines) {
    // Tool-schema and world-state lines reach megabytes and are never a title.
    if (line.length > 65536 && !line.includes('"session_meta"')) continue;
    if (!meta) {
      if (!line.includes('"session_meta"')) continue;
      try {
        meta = JSON.parse(line).payload ?? {};
      } catch {
        meta = undefined;
      }
      continue;
    }
    if (!title && line.includes('"role":"user"')) {
      try {
        const payload = JSON.parse(line).payload ?? {};
        if (payload.type === 'message' && payload.role === 'user') {
          const text = textOf(payload.content);
          if (text && !isSyntheticContext(text)) title = oneLine(text, 70);
        }
      } catch {
        // A truncated line simply cannot title the thread.
      }
    }
    if (title) break;
  }
  const result = { meta, title };
  if (PROBE_CACHE.size > 400) PROBE_CACHE.clear();
  PROBE_CACHE.set(key, result);
  return result;
}
/**
 * List Codex threads without loading transcripts.
 * @param {{home?:string}} [options]
 */
export async function scan({ home = root() } = {}) {
  const sessionsDir = path.join(home, 'sessions');
  const indexed = indexedThreads(home);
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && ROLLOUT.test(entry.name)) files.push(full);
    }
  };
  walk(sessionsDir);

  const out = [];
  for (const file of files) {
    const stat = fs.statSync(file);
    const guessId = file.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1];
    const row = guessId ? indexed.get(guessId) : undefined;
    // Codex shows the user-editable `name` when it is set.
    let title = row?.name || row?.title || '';
    let meta = row;
    if (!row || !title) {
      const probed = await probe(file);
      meta = row ?? probed.meta;
      title = title || probed.title;
    }
    out.push({
      adapter: id,
      id: row?.id ?? meta?.id ?? meta?.session_id ?? guessId ?? path.basename(file),
      path: file,
      title,
      cwd: row?.cwd ?? meta?.cwd ?? '',
      model: row?.model ?? '',
      createdAt: row?.created_at ? row.created_at * 1000 : Date.parse(meta?.timestamp ?? '') || stat.birthtimeMs,
      updatedAt: row?.updated_at ? row.updated_at * 1000 : stat.mtimeMs,
      bytes: stat.size,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Stream a rollout as canonical events.
 * @param {string} file
 */
export async function* read(file) {
  let turn = 0;
  let step = 0;
  let stepOpen = false;
  let turnOpen = false;
  try {
    for await (const line of linesOf(file)) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse(record.timestamp ?? '') || Date.now();
      const payload = record.payload ?? {};

      if (record.type === 'session_meta') {
        yield {
          k: K.meta,
          id: payload.id ?? payload.session_id,
          cwd: payload.cwd ?? '',
          createdAt: Date.parse(payload.timestamp ?? '') || at,
          provider: payload.model_provider ?? '',
          cliVersion: payload.cli_version ?? '',
        };
        continue;
      }

      if (record.type === 'event_msg') {
        if (payload.type === 'task_started') {
          turn += 1;
          step = 0;
          turnOpen = true;
          yield { k: K.turnStart, at, turn };
        } else if (payload.type === 'task_complete') {
          if (stepOpen) {
            yield { k: K.stepEnd, at, turn, step };
            stepOpen = false;
          }
          if (turnOpen) {
            yield { k: K.turnEnd, at, turn, reason: payload.error ? 'error' : 'completed' };
            turnOpen = false;
          }
        }
        continue;
      }

      if (record.type !== 'response_item') continue;

      switch (payload.type) {
        case 'message': {
          const text = textOf(payload.content);
          if (!text || payload.role === 'developer') break;
          if (payload.role === 'user') {
            if (isSyntheticContext(text)) break;
            if (!turnOpen) {
              turn += 1;
              turnOpen = true;
              yield { k: K.turnStart, at, turn };
            }
            if (stepOpen) yield { k: K.stepEnd, at, turn, step };
            step += 1;
            stepOpen = true;
            yield { k: K.stepStart, at, turn, step };
            yield { k: K.user, at, turn, step, text };
          } else if (payload.role === 'assistant') {
            if (!turnOpen) {
              turn += 1;
              turnOpen = true;
              yield { k: K.turnStart, at, turn };
            }
            if (!stepOpen) {
              step += 1;
              stepOpen = true;
              yield { k: K.stepStart, at, turn, step };
            }
            yield { k: K.assistant, at, turn, step, text };
          }
          break;
        }
        case 'reasoning': {
          const text = textOf(payload.summary) || textOf(payload.content);
          if (!text || !stepOpen) break;
          yield { k: K.assistant, at, turn, step, reasoning: text };
          break;
        }
        case 'function_call':
        case 'custom_tool_call': {
          if (!stepOpen) break;
          yield {
            k: K.toolCall,
            at,
            turn,
            step,
            callId: payload.call_id ?? payload.id,
            name: payload.namespace ? `${payload.namespace}.${payload.name}` : payload.name,
            arguments: payload.arguments ?? payload.input ?? '',
          };
          break;
        }
        case 'function_call_output':
        case 'custom_tool_call_output': {
          if (!stepOpen) break;
          yield {
            k: K.toolResult,
            at,
            turn,
            step,
            callId: payload.call_id,
            output: textOf(payload.output),
            isError: payload.success === false,
          };
          break;
        }
        default:
          break;
      }
    }
  } finally {
    // Nothing to release: `linesOf` closes its own reader.
  }
  if (stepOpen) yield { k: K.stepEnd, at: Date.now(), turn, step };
  if (turnOpen) yield { k: K.turnEnd, at: Date.now(), turn, reason: 'completed' };
}

/* ------------------------------------------------------------------ writing */

function stamp(date = new Date()) {
  return date.toISOString().replace(/\.\d+Z$/, 'Z');
}

function pathStamp(date) {
  return stamp(date).replace(/[:.]/g, '-').replace('Z', '');
}

function stateDbFile(home) {
  const names = fs.readdirSync(home).filter((n) => /^state_\d+\.sqlite$/.test(n));
  if (names.length === 0) throw new Error('no Codex state database found');
  const newest = names.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  return path.join(home, newest);
}

/**
 * Write canonical events as a Codex rollout and index it.
 *
 * @param {AsyncIterable<any>} events
 * @param {{cwd:string, title?:string, home?:string, mode?:'direct'|'staging', stagingDir?:string, createdAt?:number}} options
 */
export async function write(events, options) {
  const home = options.home ?? path.join(os.homedir(), '.codex');
  const createdAt = options.createdAt ?? Date.now();
  const mode = options.mode ?? 'staging';
  const id = crypto.randomUUID();
  const date = new Date(createdAt);
  const dir = path.join(home, 'sessions', stamp(date).slice(0, 4), stamp(date).slice(5, 7), stamp(date).slice(8, 10));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${pathStamp(date)}-${id}.jsonl`);
  const out = fs.createWriteStream(file, { encoding: 'utf8' });

  let ordinal = 0;
  let title = '';
  let firstUser = '';
  let assistantText = '';
  let messages = 0;
  let toolCalls = 0;
  let turn = 0;

  const emit = (type, payload) => {
    out.write(`${JSON.stringify({ timestamp: stamp(), ordinal: ordinal++, type, payload })}\n`);
  };

  emit('session_meta', {
    id,
    session_id: id,
    timestamp: stamp(date),
    cwd: options.cwd,
    originator: 'codex_work_desktop',
    cli_version: 'imported-by-session-bridge',
    source: 'vscode',
    model_provider: 'openai',
    thread_source: 'user',
  });

  for await (const event of events) {
    switch (event.k) {
      case 'turn/start':
        turn = event.turn;
        emit('event_msg', {
          type: 'task_started',
          turn_id: `${id}-${turn}`,
          root_turn_id: `${id}-${turn}`,
          started_at: Math.floor((event.at ?? Date.now()) / 1000),
        });
        break;
      case 'turn/end':
        emit('event_msg', {
          type: 'task_complete',
          turn_id: `${id}-${turn}`,
          root_turn_id: `${id}-${turn}`,
          last_agent_message: assistantText,
        });
        break;
      case 'user':
        if (!firstUser) firstUser = event.text;
        messages += 1;
        emit('response_item', {
          type: 'message',
          role: 'user',
          id: `msg_${crypto.randomUUID()}`,
          content: [{ type: 'input_text', text: event.text }],
        });
        break;
      case 'assistant':
        if (event.reasoning) {
          emit('response_item', {
            type: 'reasoning',
            id: `rs_${crypto.randomUUID()}`,
            summary: [{ type: 'summary_text', text: event.reasoning }],
          });
        }
        if (event.text) {
          assistantText = event.text;
          messages += 1;
          emit('response_item', {
            type: 'message',
            role: 'assistant',
            id: `msg_${crypto.randomUUID()}`,
            content: [{ type: 'output_text', text: event.text }],
          });
        }
        break;
      case 'tool/call':
        toolCalls += 1;
        emit('response_item', {
          type: 'function_call',
          id: `fc_${crypto.randomUUID()}`,
          call_id: event.callId,
          name: event.name,
          arguments: typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments ?? {}),
        });
        break;
      case 'tool/result':
        emit('response_item', {
          type: 'function_call_output',
          id: `fco_${crypto.randomUUID()}`,
          call_id: event.callId,
          output: event.output ?? '',
        });
        break;
      case 'title':
        if (!title && event.title) title = event.title;
        break;
      default:
        break;
    }
  }

  await new Promise((resolve) => out.end(resolve));

  const summary = {
    id,
    file,
    mode,
    messages,
    toolCalls,
    cwd: options.cwd,
    title: options.title || title || firstUser.slice(0, 80) || id,
    bytes: fs.statSync(file).size,
  };

  if (mode !== 'direct') {
    const staging = options.stagingDir ?? path.join(os.tmpdir(), 'session-bridge-export');
    fs.mkdirSync(staging, { recursive: true });
    const target = path.join(staging, path.basename(file));
    fs.copyFileSync(file, target);
    summary.file = target;
    return summary;
  }

  // Direct install: back the index up, then add exactly one row.
  const dbFile = stateDbFile(home);
  const backup = `${dbFile}.asb-backup-${Date.now()}`;
  fs.copyFileSync(dbFile, backup);
  // Each backup is a full index copy (~9 MB), so keep only the newest few.
  const backups = fs
    .readdirSync(home)
    .filter((name) => name.startsWith(`${path.basename(dbFile)}.asb-backup-`))
    .sort()
    .reverse();
  for (const stale of backups.slice(3)) {
    try {
      fs.unlinkSync(path.join(home, stale));
    } catch {
      // A backup that cannot be removed is left in place.
    }
  }
  const sqlite = globalThis.process?.getBuiltinModule?.('node:sqlite');
  if (!sqlite) throw new Error('node:sqlite is unavailable; cannot index the thread');
  const seconds = Math.floor(createdAt / 1000);
  const db = new sqlite.DatabaseSync(dbFile);
  try {
    db.prepare(
      'insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, ' +
        'sandbox_policy, approval_mode, tokens_used, has_user_event, archived, cli_version, first_user_message, ' +
        'memory_mode, thread_source, preview, recency_at, history_mode, originator, name) ' +
        'values (?,?,?,?,?,?,?,?,?,?,0,1,0,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      file,
      seconds,
      seconds,
      'vscode',
      'openai',
      options.cwd,
      summary.title,
      '{"type":"disabled"}',
      'never',
      'imported-by-session-bridge',
      firstUser.slice(0, 400),
      'enabled',
      'user',
      assistantText.slice(0, 200),
      seconds,
      'paginated',
      'codex_work_desktop',
      summary.title,
    );
  } finally {
    db.close();
  }
  summary.backup = backup;

  // Codex only lists a thread that its own UI state knows about, so record the
  // membership too. The state file is a live cache: verify after a restart.
  const project = findProject(home, options.cwd);
  if (project) {
    try {
      const stateFile = path.join(home, '.codex-global-state.json');
      const stateBackup = `${stateFile}.asb-backup-${Date.now()}`;
      if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, stateBackup);
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      state['thread-project-assignments'] = state['thread-project-assignments'] ?? {};
      state['thread-project-assignments'][id] = { projectKind: 'local', projectId: project.id };
      state['thread-project-membership-host-ids'] = state['thread-project-membership-host-ids'] ?? {};
      state['thread-project-membership-host-ids'][id] = 'local';
      state['sidebar-project-thread-orders'] = state['sidebar-project-thread-orders'] ?? {};
      const order = state['sidebar-project-thread-orders'][project.id] ?? { threadIds: [] };
      order.threadIds = [id, ...(order.threadIds ?? []).filter((existing) => existing !== id)];
      state['sidebar-project-thread-orders'][project.id] = order;
      const tmp = `${stateFile}.asb-tmp-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, stateFile);
      summary.stateBackup = stateBackup;
      summary.project = project.name;
    } catch {
      // A locked or malformed state file leaves the thread indexed but unlisted.
    }
  }
  return summary;
}

/** The local project whose root is the target working directory. */
function findProject(home, cwd) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(home, '.codex-global-state.json'), 'utf8'));
    for (const projectId of state['project-order'] ?? []) {
      const project = state['local-projects']?.[projectId];
      if (project?.rootPaths?.includes(cwd)) return { id: projectId, name: project.name };
    }
  } catch {
    // No readable UI state: the thread is indexed without a project.
  }
  return undefined;
}
