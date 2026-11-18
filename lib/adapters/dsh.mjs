/**
 * DeepSeek Harness adapter.
 *
 * Reads and writes the v4 session log: concatenated zstd frames whose first
 * frame is exactly one header line. Required fields for every event come from
 * the installed persistence schema, and `surfaceOp` is added only for the event
 * types whose envelope demands it — so a schema change is followed rather than
 * guessed.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { iterLogLines, SessionLogWriter } from '../zstd.mjs';
import { loadSchema } from '../dsh-schema.mjs';
import {
  projectDirName,
  encodeSegment,
  sessionsRoot,
  logFileName,
  dshHome,
  readWorkspaceDoc,
} from '../dsh-path.mjs';
import { K, oneLine, isSyntheticContext } from '../protocol.mjs';

export const id = 'dsh';
export const label = 'DeepSeek Harness';
export const writes = 'direct';
export const FORMAT_VERSION = 4;

const LOG_FILE = /^session(\.v(\d+))?\.jsonl(\.zstd)?$/;

export function detect({ home } = {}) {
  return fs.existsSync(sessionsRoot(home));
}

function logVersion(name) {
  return Number(name.match(/\.v(\d+)\./)?.[1] ?? 0);
}

function pickLog(dir) {
  let best;
  for (const name of fs.readdirSync(dir)) {
    if (!LOG_FILE.test(name)) continue;
    const version = logVersion(name);
    if (!best || version > best.version) {
      best = { name, version, compressed: name.endsWith('.zstd') };
    }
  }
  return best;
}

/** Workspace paths, so a listing can name the project a session belongs to. */
function workspaceIndex(home) {
  const doc = readWorkspaceDoc(home);
  const map = new Map();
  for (const ws of Object.values(doc?.tables?.workspaces ?? {})) {
    for (const sessionId of ws.sessionIds ?? []) map.set(sessionId, ws.title || path.basename(ws.path));
  }
  return map;
}

/**
 * List sessions by reading only each log's header, plus a short bounded scan
 * for the title. Never loads a whole transcript.
 * @param {{home?:string}} [options]
 */
export async function scan({ home = dshHome() } = {}) {
  const rootDir = sessionsRoot(home);
  const projects = workspaceIndex(home);
  const out = [];
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(rootDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return out;
  }
  for (const project of projectDirs) {
    const projectPath = path.join(rootDir, project.name);
    for (const sessionEntry of fs.readdirSync(projectPath, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue;
      const dir = path.join(projectPath, sessionEntry.name);
      const log = pickLog(dir);
      if (!log) continue;
      const file = path.join(dir, log.name);
      const stat = fs.statSync(file);
      let header;
      let title = '';
      try {
        for await (const line of iterLogLines(file)) {
          if (!header) {
            header = JSON.parse(line);
            continue;
          }
          if (line.includes('"session/title"')) {
            title = JSON.parse(line).data?.title ?? '';
            break;
          }
          if (line.includes('"user/message"')) {
            const text = JSON.parse(line).data?.content?.find((b) => b.type === 'text')?.text ?? '';
            if (!title) title = oneLine(text, 70);
          }
        }
      } catch {
        continue;
      }
      if (!header) continue;
      out.push({
        adapter: id,
        id: header.id,
        path: file,
        title: oneLine(title || projects.get(header.id) || '', 70),
        cwd: header.cwd ?? '',
        model: '',
        createdAt: header.createdAt ?? stat.birthtimeMs,
        updatedAt: stat.mtimeMs,
        bytes: stat.size,
        formatVersion: header.version ?? log.version,
        compressed: log.compressed,
      });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function textOfBlocks(content, type) {
  return (content ?? [])
    .filter((block) => block?.type === type && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Stream a DSH session log as canonical events.
 * @param {string} file
 */
export async function* read(file) {
  let header;
  for await (const line of iterLogLines(file)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!header) {
      header = event;
      yield {
        k: K.meta,
        id: event.id,
        cwd: event.cwd ?? '',
        createdAt: event.createdAt ?? 0,
        agentPreset: event.agentPreset ?? '',
        parent: event.parentSession ?? null,
        formatVersion: event.version ?? 0,
      };
      continue;
    }
    const at = event.time ?? 0;
    const data = event.data ?? {};
    switch (event.type) {
      case 'turn/start':
        yield { k: K.turnStart, at, turn: data.turn };
        break;
      case 'turn/end':
        yield { k: K.turnEnd, at, turn: data.turn, reason: data.reason?.kind ?? 'completed' };
        break;
      case 'step/start':
        yield { k: K.stepStart, at, turn: data.turn, step: data.step };
        break;
      case 'step/end':
        yield { k: K.stepEnd, at, turn: data.turn, step: data.step };
        break;
      case 'user/message': {
        const text = textOfBlocks(data.content, 'text');
        if (text && !isSyntheticContext(text)) yield { k: K.user, at, turn: data.turn, step: data.step, text };
        break;
      }
      case 'assistant/message': {
        const content = data.message?.content ?? [];
        yield {
          k: K.assistant,
          at,
          turn: data.turn,
          step: data.step,
          text: textOfBlocks(content, 'text'),
          reasoning: textOfBlocks(content, 'reasoning'),
          model: data.message?.source?.model ?? '',
          provider: data.message?.source?.provider ?? '',
        };
        break;
      }
      case 'tool/call':
        yield {
          k: K.toolCall,
          at,
          turn: data.turn,
          step: data.step,
          callId: data.callId,
          name: data.name,
          arguments: data.arguments ?? '',
        };
        break;
      case 'tool/result':
        yield {
          k: K.toolResult,
          at,
          turn: data.turn,
          step: data.step,
          callId: data.message?.toolCallId ?? data.message?.source?.callId,
          output: textOfBlocks(data.message?.content, 'text'),
          isError: data.message?.isError === true,
        };
        break;
      case 'session/title':
        if (data.title) yield { k: K.title, at, title: data.title };
        break;
      default:
        break;
    }
  }
}

const FALLBACK_SURFACE = new Set([
  'user/message',
  'assistant/message',
  'system/message',
  'tool/result',
  'developer/message',
]);

/**
 * Write canonical events as a v4 session log.
 * @param {AsyncIterable<any>} events
 * @param {{cwd:string, sessionId:string, home?:string, title?:string, model?:string}} options
 */
export async function write(events, options) {
  const sessionId = options.sessionId ?? `session-${crypto.randomUUID()}`;
  const cwd = options.cwd;
  if (!path.isAbsolute(cwd)) throw new Error(`cwd must be absolute, got ${cwd}`);
  const home = options.home;
  const dir = path.join(sessionsRoot(home), projectDirName(cwd), encodeSegment(sessionId));
  const file = path.join(dir, logFileName(FORMAT_VERSION, 'zstd'));

  const schema = loadSchema();
  const envelope = (type) => schema?.events?.[type]?.envelope;
  const isSurface = (type) => (envelope(type) ? envelope(type).includes('surfaceOp') : FALLBACK_SURFACE.has(type));

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const writer = new SessionLogWriter(file);

  let seq = 0;
  let createdAt = options.createdAt ?? Date.now();
  let count = 0;
  const callSeqs = new Map();
  // Calls advertised and started but never resolved: DSH rejects a step that
  // ends with one outstanding, so they get an explicit empty result.
  let unresolved = new Map();
  let title = oneLine(options.title ?? '', 80);
  let firstUserSeq;
  let pendingAssistant = [];
  let pendingToolCalls = [];
  let openTurn = 0;
  let openStep = 0;
  let writerTurn = 0;
  let writerStep = 0;
  let stepOpen = false;
  let turnOpen = false;

  const line = (type, data, at, extra) => {
    const event = { type, seq, time: at ?? Date.now(), data };
    if (extra) Object.assign(event, extra);
    if (isSurface(type)) event.surfaceOp = 'append';
    seq += 1;
    count += 1;
    writer.writeEvent(JSON.stringify(event));
    return event.seq;
  };

  const flushAssistant = (at) => {
    if (pendingAssistant.length === 0 && pendingToolCalls.length === 0) return;
    const blocks = [];
    let model = options.model ?? 'unknown';
    let provider = 'unknown';
    for (const item of pendingAssistant) {
      if (item.reasoning) blocks.push({ type: 'reasoning', text: item.reasoning });
      if (item.text) blocks.push({ type: 'text', text: item.text });
      if (item.model) model = item.model;
      if (item.provider) provider = item.provider;
    }
    for (const call of pendingToolCalls) {
      blocks.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments });
    }
    pendingAssistant = [];
    pendingToolCalls = [];
    if (blocks.length === 0) return;
    line(
      'assistant/message',
      {
        turn: openTurn,
        step: openStep,
        message: {
          role: 'assistant',
          content: blocks,
          source: { kind: 'model', provider, model },
          id: crypto.randomUUID(),
        },
        stream: [],
      },
      at,
    );
  };

  // DSH enforces turn numbers 1..n and, inside a turn, steps 1..n with no gaps.
  // Source numbering never satisfies that reliably, so the writer renumbers.
  const ensureTurn = (at) => {
    if (turnOpen) return openTurn;
    writerTurn += 1;
    writerStep = 0;
    openTurn = writerTurn;
    turnOpen = true;
    line('turn/start', { turn: openTurn }, at);
    return openTurn;
  };

  const ensureStep = (at) => {
    ensureTurn(at);
    if (stepOpen) return openStep;
    writerStep += 1;
    openStep = writerStep;
    stepOpen = true;
    line('step/start', { turn: openTurn, step: openStep }, at);
    return openStep;
  };

  const closeStep = (at) => {
    if (!stepOpen) return;
    flushAssistant(at);
    for (const [callId, name] of unresolved) {
      line(
        'tool/result',
        {
          turn: openTurn,
          step: openStep,
          message: {
            role: 'tool',
            source: { kind: 'tool', callId },
            toolCallId: callId,
            content: [{ type: 'text', text: `(no result recorded for ${name} in the source session)` }],
            isError: true,
            id: crypto.randomUUID(),
          },
        },
        at,
        callSeqs.has(callId) ? { sourceEventSeqs: [callSeqs.get(callId)] } : undefined,
      );
    }
    unresolved = new Map();
    line('step/end', { turn: openTurn, step: openStep }, at);
    stepOpen = false;
  };

  const closeTurn = (at, reason = 'completed') => {
    if (!turnOpen) return;
    closeStep(at);
    line('turn/end', { turn: openTurn, reason: { kind: reason } }, at);
    turnOpen = false;
  };

  const header = {
    type: 'session',
    version: FORMAT_VERSION,
    id: sessionId,
    createdAt,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: options.agentPreset ?? 'standard',
  };
  writer.writeHeader(JSON.stringify(header));
  line('permission/preset', { preset: 'workspace-write' }, createdAt);
  line('sandbox/mode', { mode: 'workspace-write' }, createdAt);
  line('approval/policy', { policy: 'ask' }, createdAt);

  for await (const event of events) {
    switch (event.k) {
      case K.meta:
        break;
      case K.turnStart:
        closeTurn(event.at);
        ensureTurn(event.at);
        break;
      case K.turnEnd:
        closeTurn(event.at, event.reason);
        break;
      case K.stepStart:
        closeStep(event.at);
        ensureStep(event.at);
        break;
      case K.stepEnd:
        closeStep(event.at);
        break;
      case K.user: {
        ensureStep(event.at);
        if (!title) title = oneLine(event.text, 80);
        const id = line(
          'user/message',
          {
            content: [{ type: 'text', text: event.text }],
            source: { kind: 'user', clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
            role: 'user',
            id: crypto.randomUUID(),
          },
          event.at,
        );
        if (firstUserSeq === undefined) firstUserSeq = id;
        break;
      }
      case K.assistant:
        ensureStep(event.at);
        pendingAssistant.push(event);
        break;
      case K.toolCall: {
        ensureStep(event.at);
        // DSH only accepts a tool/call whose call id was advertised as a
        // `tool-call` content block of an assistant message in the same step.
        pendingToolCalls.push({
          id: event.callId,
          name: event.name,
          arguments: typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments ?? {}),
        });
        flushAssistant(event.at);
        const callSeq = line(
          'tool/call',
          {
            turn: openTurn,
            step: openStep,
            callId: event.callId,
            name: event.name,
            arguments: typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments ?? {}),
          },
          event.at,
        );
        callSeqs.set(event.callId, callSeq);
        unresolved.set(event.callId, event.name);
        break;
      }
      case K.toolResult: {
        flushAssistant(event.at);
        const origin = callSeqs.get(event.callId);
        line(
          'tool/result',
          {
            turn: openTurn,
            step: openStep,
            message: {
              role: 'tool',
              source: { kind: 'tool', callId: event.callId },
              toolCallId: event.callId,
              content: [{ type: 'text', text: event.output ?? '' }],
              isError: event.isError === true,
              id: crypto.randomUUID(),
            },
          },
          event.at,
          origin === undefined ? undefined : { sourceEventSeqs: [origin] },
        );
        callSeqs.delete(event.callId);
        unresolved.delete(event.callId);
        break;
      }
      case K.title:
        if (!title && event.title) title = event.title;
        break;
      default:
        break;
    }
  }

  closeTurn(Date.now());

  if (title && firstUserSeq !== undefined) {
    line('session/title', { title, messageSeqs: [firstUserSeq], source: { kind: 'fallback' } }, createdAt + 1);
  }

  const frames = writer.close();
  return { file, dir, sessionId, events: count, frames, bytes: fs.statSync(file).size, title, cwd };
}
