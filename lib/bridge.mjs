/**
 * One dedicated "bridge" project on each side.
 *
 * Both harnesses validate a session by its real working directory, so a single
 * shared folder can serve as the DSH Workspace and the Codex Project at once.
 * Migrations then land somewhere predictable instead of scattering across
 * whatever folder the source happened to use.
 *
 * Creation is idempotent and reversible: nothing is removed, and an existing
 * project over the same path is reused.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { codexHome as defaultCodexHome } from './install.mjs';
import { readWorkspaceDoc, writeJsonAtomic } from './dsh-path.mjs';

export const DEFAULT_NAME = 'Session Bridge';

/** Resolve the configured folder, expanding `~` and defaulting to the home. */
export function bridgeConfig(config = {}) {
  const bridge = config.bridge ?? {};
  const enabled = bridge.enabled !== false;
  const name = typeof bridge.name === 'string' && bridge.name.trim() ? bridge.name.trim() : DEFAULT_NAME;
  const raw = typeof bridge.path === 'string' && bridge.path.trim() ? bridge.path.trim() : path.join(os.homedir(), DEFAULT_NAME);
  const dir = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  return { enabled, name, dir: path.resolve(dir) };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function stateFile(home) {
  return path.join(home, '.codex-global-state.json');
}

function stateDbFile(home) {
  const names = (() => {
    try {
      return fs.readdirSync(home).filter((n) => /^state_\d+\.sqlite$/.test(n));
    } catch {
      return [];
    }
  })();
  if (names.length === 0) return undefined;
  const newest = names.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  return path.join(home, newest);
}

/** The Codex project already covering this folder, if any. */
export function existingCodexProject(home, dir) {
  const state = readJson(stateFile(home));
  if (!state?.['local-projects']) return undefined;
  for (const [id, project] of Object.entries(state['local-projects'])) {
    if (project?.rootPaths?.includes(dir)) return { id, name: project.name };
  }
  return undefined;
}

/**
 * Register the bridge folder as a Codex project.
 * Backs up both the index database and the UI state before changing either.
 * @returns {{ok:boolean, created:boolean, projectId?:string, backup?:string, stateBackup?:string, reason?:string}}
 */
export function ensureCodexProject(home = defaultCodexHome(), dir, name = DEFAULT_NAME) {
  fs.mkdirSync(dir, { recursive: true });
  const existing = existingCodexProject(home, dir);
  if (existing) return { ok: true, created: false, projectId: existing.id, name: existing.name };

  const file = stateFile(home);
  const state = readJson(file);
  if (!state) return { ok: false, created: false, reason: 'Codex UI state not found; is Codex installed?' };

  const localId = crypto.randomUUID();
  const appId = crypto.randomUUID();
  const now = Date.now();

  let dbBackup;
  const dbFile = stateDbFile(home);
  const sqlite = globalThis.process?.getBuiltinModule?.('node:sqlite');
  if (dbFile && sqlite) {
    try {
      dbBackup = `${dbFile}.asb-backup-${now}`;
      fs.copyFileSync(dbFile, dbBackup);
      const db = new sqlite.DatabaseSync(dbFile);
      try {
        const position = db.prepare('select coalesce(max(position), -1) + 1 as next from projects').get().next;
        db.prepare(
          'insert into projects (id, name, metadata, position, created_at_ms, updated_at_ms) values (?,?,?,?,?,?)',
        ).run(appId, name, '{}', position, now, now);
        db.prepare('insert into project_roots (project_id, position, path) values (?,?,?)').run(appId, 0, dir);
      } finally {
        db.close();
      }
    } catch (error) {
      return { ok: false, created: false, reason: `cannot index the Codex project: ${error?.message ?? error}` };
    }
  }

  const stateBackup = `${file}.asb-backup-${now}`;
  fs.copyFileSync(file, stateBackup);
  state['local-projects'] = state['local-projects'] ?? {};
  state['local-projects'][localId] = { id: localId, name, rootPaths: [dir], createdAt: now, updatedAt: now };
  state['project-order'] = [localId, ...(state['project-order'] ?? []).filter((id) => id !== localId)];
  const mapKey = `local:${home}`;
  const mapping = state['app-server-project-id-by-legacy-project-id-by-host'] ?? {};
  mapping[mapKey] = { ...(mapping[mapKey] ?? {}), [localId]: appId };
  state['app-server-project-id-by-legacy-project-id-by-host'] = mapping;

  const tmp = `${file}.asb-tmp-${now}`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);

  return { ok: true, created: true, projectId: localId, backup: dbBackup, stateBackup };
}

/**
 * Ensure the folder is a DSH Workspace. Prefers the live service so the panel
 * refreshes immediately, and falls back to the registry file plus a restart.
 */
export async function ensureDshWorkspace(ctx, dir, name = DEFAULT_NAME) {
  fs.mkdirSync(dir, { recursive: true });
  // The service is idempotent and updates the live registry, so it is always
  // tried first: a file-only registration can be overwritten by the running app.
  const controller = ctx?.get?.('workspaceController');
  // Ask the live registry first: `create` resolves an existing directory but the
  // app only knows about workspaces in its in-memory registry, so calling it
  // blind would add a second Workspace over the same folder.
  const registry = ctx?.get?.('workspaceRegistry');
  try {
    for (const workspace of registry?.list?.() ?? []) {
      const workspaceId = workspace.workspaceId ?? workspace.id;
      if (workspace.path === dir) return { ok: true, created: false, workspaceId, restartRequired: false };
    }
  } catch {
    // A registry that cannot list falls through to `create`.
  }
  if (controller) {
    try {
      const result = await controller.create({ path: dir });
      return {
        ok: true,
        created: result.created,
        workspaceId: result.workspace.workspaceId,
        restartRequired: false,
      };
    } catch {
      // Fall through to the registry file.
    }
  }
  const doc = readWorkspaceDoc();
  for (const [id, value] of Object.entries(doc?.tables?.workspaces ?? {})) {
    if (value.path === dir) return { ok: true, created: false, workspaceId: id, restartRequired: true };
  }
  if (!doc?.tables?.workspaces || !doc.global) {
    return { ok: false, created: false, reason: 'DSH workspace registry not found' };
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  doc.tables.workspaces[id] = { path: dir, title: name, sessionIds: [], createdAt: now, updatedAt: now };
  doc.global.workspaceIds = [...(doc.global.workspaceIds ?? []), id];
  writeJsonAtomic(path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'storages', 'workspace.json'), doc);
  return { ok: true, created: true, workspaceId: id, restartRequired: true };
}

/**
 * Create the bridge on both sides. Safe to call on every activation.
 * @param {{ctx?: any, config?: any, codexHome?: string}} input
 */
export async function ensureBridge({ ctx, config, codexHome } = {}) {
  const { enabled, name, dir } = bridgeConfig(config);
  if (!enabled) return { enabled: false };
  const dsh = await ensureDshWorkspace(ctx, dir, name);
  const codex = ensureCodexProject(codexHome ?? defaultCodexHome(), dir, name);
  return { enabled: true, dir, name, dsh, codex };
}
