/**
 * DSH on-disk layout: project directory names, session directory names,
 * session log paths, and the workspace registry.
 *
 * Everything here is derived from the installed DSH's own persistence layout
 * (dsh-session-persistence-jsonl). The encoders are re-implemented rather than
 * imported because that package does not export them; `verifyLayout()` checks
 * the result against the real directories on disk so drift surfaces loudly.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SAFE = /[A-Za-z0-9._-]/;
const SEPARATORS = new Set(['/', '\\', ':']);

/** @param {string} cwd */
export function projectKey(cwd) {
  let out = '';
  let lastWasSeparator = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const ch = cwd[i];
    if (SEPARATORS.has(ch)) {
      if (!lastWasSeparator) out += '-';
      lastWasSeparator = true;
      continue;
    }
    lastWasSeparator = false;
    if (SAFE.test(ch)) {
      out += ch;
    } else {
      out += `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  out = out.replace(/^-+/, '');
  if (out.length === 0) out = 'root';
  if (out.length > 251) out = out.slice(0, 251);
  return out;
}

/** @param {string} cwd @returns {string} */
export function projectDirName(cwd) {
  if (!cwd) return '_no-cwd';
  return `--${projectKey(cwd)}--`;
}

/** @param {string} id */
export function encodeSegment(id) {
  if (id === '.' || id === '..') {
    return [...id]
      .map((ch) => `~${id.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
      .join('');
  }
  let out = '';
  for (let i = 0; i < id.length; i += 1) {
    const ch = id[i];
    out += SAFE.test(ch) ? ch : `~${id.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/** @param {string} [home] */
export function dshHome(home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  return home;
}

/** @param {string} [home] */
export function sessionsRoot(home) {
  return path.join(dshHome(home), 'sessions');
}

/**
 * @param {string} cwd
 * @param {string} id
 * @param {{home?: string}} [options]
 */
export function sessionDir(cwd, id, options = {}) {
  return path.join(sessionsRoot(options.home), projectDirName(cwd), encodeSegment(id));
}

/** @param {number} version */
export function logFileName(version = 4, compression = 'zstd') {
  const base = version === 0 ? 'session.jsonl' : `session.v${version}.jsonl`;
  return compression === 'zstd' ? `${base}.zstd` : base;
}

/**
 * @param {string} cwd
 * @param {string} id
 * @param {{home?: string, version?: number, compression?: 'zstd'|'none'}} [options]
 */
export function logPath(cwd, id, options = {}) {
  return path.join(sessionDir(cwd, id, options), logFileName(options.version ?? 4, options.compression ?? 'zstd'));
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** @param {string} [home] */
export function workspaceDocPath(home) {
  return path.join(dshHome(home), 'storages', 'workspace.json');
}

/** @param {string} [home] */
export function readWorkspaceDoc(home) {
  return readJsonSafe(workspaceDocPath(home));
}

/**
 * Atomic replace: write a sibling temp file, then rename over the target.
 * @param {string} file
 * @param {unknown} value
 */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.asb-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Register a session id at the head of a workspace's sessionIds.
 * Only ids whose header.cwd realpaths to the workspace path are acceptable to DSH.
 * @param {{home?: string, workspacePath: string, sessionId: string, dryRun?: boolean}} input
 */
export function addSessionToWorkspace({ home, workspacePath, sessionId, dryRun = false }) {
  const doc = readWorkspaceDoc(home);
  if (!doc?.tables?.workspaces) return { ok: false, reason: 'workspace registry not found' };
  let wsId;
  let ws;
  for (const [id, value] of Object.entries(doc.tables.workspaces)) {
    if (value.path === workspacePath) {
      wsId = id;
      ws = value;
      break;
    }
  }
  if (!ws) return { ok: false, reason: `no workspace registered for ${workspacePath}` };
  if (ws.sessionIds.includes(sessionId)) return { ok: true, workspaceId: wsId, changed: false };
  ws.sessionIds.unshift(sessionId);
  ws.updatedAt = new Date().toISOString();
  if (!dryRun) writeJsonAtomic(workspaceDocPath(home), doc);
  return { ok: true, workspaceId: wsId, changed: true };
}

/**
 * Compare the computed project directory name for a cwd against what DSH
 * actually wrote, so an encoding change in a future DSH release is detectable
 * instead of silently producing an unreadable session.
 * @param {string} [home]
 */
export function verifyLayout(home) {
  const root = sessionsRoot(home);
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { ok: false, reason: `cannot read ${root}` };
  }
  const findings = [];
  for (const dir of dirs) {
    const projectDir = path.join(root, dir);
    const sessionDirs = fs
      .readdirSync(projectDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const sessionDirName of sessionDirs) {
      const log = fs
        .readdirSync(path.join(projectDir, sessionDirName))
        .find((name) => /^session(\.v\d+(\.jsonl)?|\.jsonl)(\.zstd)?$/.test(name));
      if (!log) continue;
      findings.push({ dir, sessionDirName, log });
      break;
    }
  }
  return { ok: findings.length > 0, projects: findings.length, sample: findings.slice(0, 3) };
}
