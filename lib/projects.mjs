/**
 * Project structure for both harnesses.
 *
 * Codex Desktop groups threads by working directory and keeps the named roots
 * in its `projects` / `project_roots` tables (threads.project_id is unused).
 * DSH keeps workspace membership in storages/workspace.json. This module turns
 * either into the same {id, label, path} shape so the panel can show a tree.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readWorkspaceDoc } from './dsh-path.mjs';

/**
 * Small mtime-keyed cache. Codex's UI state is ~1 MB and is read on every panel
 * load; parsing it again for an unchanged file is pure waste.
 */
const jsonCache = new Map();

function readJson(file) {
  try {
    const stat = fs.statSync(file);
    const key = `${file}|${stat.mtimeMs}|${stat.size}`;
    const cached = jsonCache.get(key);
    if (cached) return cached;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (jsonCache.size > 8) jsonCache.clear();
    jsonCache.set(key, value);
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Rebuild the Codex sidebar exactly as Codex itself lays it out.
 *
 * Codex does not derive its list from working directories. It persists the
 * layout in `.codex-global-state.json`:
 *   project-order                    project ids, top to bottom
 *   local-projects                   id -> { name, rootPaths }
 *   thread-project-assignments       threadId -> { projectId }
 *   sidebar-project-thread-orders    per-project manual thread order
 *   projectless-thread-ids           threads shown outside every project
 * Internal threads (thread_source "guardian_review") are never assigned, which
 * is why they must not be listed.
 *
 * @param {string} home
 * @param {{id:string,updatedAt?:number}[]} rows scanned sessions
 * @returns {{id:string,label:string,path:string,sessions:any[]}[]|undefined}
 */
export function codexSidebar(home, rows) {
  const state = readJson(path.join(home, '.codex-global-state.json'));
  if (!state || !state['local-projects'] || !Array.isArray(state['project-order'])) return undefined;
  const projects = state['local-projects'];
  const assignments = state['thread-project-assignments'] ?? {};
  const orders = state['sidebar-project-thread-orders'] ?? {};
  const byId = new Map(rows.filter((row) => row.adapter === 'codex').map((row) => [row.id, row]));

  const groups = [];
  for (const projectId of state['project-order']) {
    const project = projects[projectId];
    if (!project) continue;
    let ids = Object.entries(assignments)
      .filter(([, value]) => value && value.projectId === projectId)
      .map(([threadId]) => threadId);
    const custom = orders[projectId]?.threadIds;
    const sessions = [];
    if (Array.isArray(custom) && custom.length > 0) {
      const ordered = [...custom, ...ids.filter((id) => !custom.includes(id))];
      for (const id of ordered) {
        const row = byId.get(id);
        if (row) sessions.push(row);
      }
    } else {
      for (const id of ids) {
        const row = byId.get(id);
        if (row) sessions.push(row);
      }
      sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    }
    groups.push({
      id: projectId,
      label: project.name || path.basename(project.rootPaths?.[0] ?? 'project'),
      path: project.rootPaths?.[0] ?? '',
      sessions,
    });
  }

  const loose = (state['projectless-thread-ids'] ?? []).map((id) => byId.get(id)).filter(Boolean);
  if (loose.length > 0) {
    groups.push({ id: '__projectless__', label: '未分组 / Ungrouped', path: '', sessions: loose });
  }
  return groups;
}

/**
 * @param {string} home
 * @returns {{id:string,label:string,path:string}[]}
 */
export function codexProjects(home = path.join(os.homedir(), '.codex')) {
  const sqlite = globalThis.process?.getBuiltinModule?.('node:sqlite');
  const names = (() => {
    try {
      return fs.readdirSync(home).filter((n) => /^state_\d+\.sqlite$/.test(n));
    } catch {
      return [];
    }
  })();
  if (!sqlite || names.length === 0) return [];
  const newest = names.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  try {
    const db = new sqlite.DatabaseSync(path.join(home, newest), { readOnly: true });
    const rows = db
      .prepare(
        'select p.id as id, p.name as name, r.path as root ' +
          'from projects p left join project_roots r on r.project_id = p.id and r.position = 0',
      )
      .all();
    db.close();
    return rows
      .filter((row) => row.root)
      .map((row) => ({ id: row.id, label: row.name || path.basename(row.root), path: row.root }));
  } catch {
    return [];
  }
}

/** DSH workspaces, in the order the app shows them. */
export function dshProjects(home) {
  const doc = readWorkspaceDoc(home);
  const global = doc?.global ?? {};
  const order = global.workspaceIds ?? Object.keys(doc?.tables?.workspaces ?? {});
  return order
    .map((id) => {
      const ws = doc?.tables?.workspaces?.[id];
      if (!ws) return undefined;
      return { id, label: ws.title || path.basename(ws.path), path: ws.path };
    })
    .filter(Boolean);
}

/**
 * Bucket sessions under projects by working directory.
 * Sessions whose cwd matches no root become one trailing "ungrouped" bucket so
 * nothing silently disappears from the tree.
 * @param {{id:string,title:string,cwd:string}[]} sessions
 * @param {{id:string,label:string,path:string}[]} projects
 * @param {string} ungroupedLabel
 */
export function groupSessions(sessions, projects, ungroupedLabel) {
  // Two project rows can share one root path (Codex records duplicates), so
  // collapse by path first; otherwise the same sessions are counted twice.
  const unique = [];
  const seen = new Set();
  for (const project of projects) {
    if (!project.path || seen.has(project.path)) continue;
    seen.add(project.path);
    unique.push({ ...project, sessions: [] });
  }
  const byPath = new Map(unique.map((group) => [group.path, group]));
  const groups = unique;
  const loose = [];
  for (const session of sessions) {
    const group = byPath.get(session.cwd);
    if (group) group.sessions.push(session);
    else loose.push(session);
  }
  // Empty projects are kept: a project is also a migration *destination*, and
  // the bridge inbox starts empty by design.
  const kept = groups;
  if (loose.length > 0) {
    kept.push({ id: '__ungrouped__', label: ungroupedLabel, path: '', sessions: loose });
  }
  for (const group of kept) group.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return kept.sort((a, b) => b.sessions.length - a.sessions.length);
}
