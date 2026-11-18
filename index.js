/**
 * Agent Session Bridge — Host half.
 *
 * Serves the panel's HTTP endpoints and one agent tool, both on top of the
 * same engine functions so the UI and the model can never drift apart.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tree, preview, migrate, verifyDshLog, readLedger, loadAdapters } from './lib/engine.mjs';
import { drift } from './lib/dsh-schema.mjs';
import { installedPackage } from './lib/install.mjs';
import fs from 'node:fs';

/** Read the drift baseline lazily: no import-attribute dependency on the loader. */
const baseline = JSON.parse(fs.readFileSync(new URL('./schema/baseline.json', import.meta.url), 'utf8'));

export const name = 'dsh-session-bridge';
export const inject = ['webServer', 'tools'];

/**
 * Resolve DSH's tool helper at activation time.
 *
 * A bundle installed from a local directory is linked, not copied, so a static
 * import of a package that ships inside the DSH installation cannot resolve.
 * The running installation still exposes it, so resolve from there.
 */
async function loadDefineTool() {
  try {
    return (await import('@deepseek-ai/dsh-tools')).defineTool;
  } catch {
    const pkg = installedPackage('dsh-tools');
    if (!pkg) return undefined;
    try {
      return (await import(pathToFileURL(path.join(pkg, 'lib', 'index.js')).href)).defineTool;
    } catch {
      return undefined;
    }
  }
}

const API = '/agent-bridge';

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Loopback only, and only our own page may call it. */
function refused(req, origin) {
  const remote = req.socket?.remoteAddress ?? '';
  if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
    return 'not loopback';
  }
  const caller = req.headers.origin;
  if (caller && origin && caller !== origin) return 'cross-origin';
  return undefined;
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Everything the panel renders, in one round trip. */
async function state() {
  const { groups, summary } = await tree();
  const adapters = [...(await loadAdapters()).values()].map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    writes: adapter.writes,
  }));
  return {
    adapters,
    groups,
    summary,
    ledger: readLedger().entries.slice(0, 20),
    schema: drift(baseline),
  };
}

export async function apply(ctx) {
  const origin = ctx.webServer.getOrigin?.();

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${API}/state`,
      handler: async (req, res) => {
        const deny = refused(req, origin);
        if (deny) return send(res, 403, { error: deny });
        if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
        try {
          send(res, 200, await state());
        } catch (error) {
          send(res, 500, { error: String(error?.message ?? error) });
        }
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${API}/migrate`,
      handler: async (req, res) => {
        const deny = refused(req, origin);
        if (deny) return send(res, 403, { error: deny });
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
        try {
          const body = await readBody(req);
          const result = await migrate(body);
          send(res, result.ok ? 200 : 409, result);
        } catch (error) {
          send(res, 500, { error: String(error?.message ?? error) });
        }
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${API}/preview`,
      handler: async (req, res) => {
        const deny = refused(req, origin);
        if (deny) return send(res, 403, { error: deny });
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
        try {
          send(res, 200, await preview(await readBody(req)));
        } catch (error) {
          send(res, 500, { error: String(error?.message ?? error) });
        }
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${API}/verify`,
      handler: async (req, res) => {
        const deny = refused(req, origin);
        if (deny) return send(res, 403, { error: deny });
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
        try {
          const { file } = await readBody(req);
          if (typeof file !== 'string') return send(res, 400, { error: 'file is required' });
          send(res, 200, await verifyDshLog(file));
        } catch (error) {
          send(res, 500, { error: String(error?.message ?? error) });
        }
      },
    }),
  );

  const defineTool = await loadDefineTool();
  if (!defineTool) return; // the panel still works without the agent tool

  ctx.tools.register(
    defineTool({
      name: 'session_bridge',
      description:
        'Move one coding-agent conversation between DeepSeek Harness and Codex, in either direction. ' +
        'action=list shows sessions grouped by project; action=preview reports turn/message/tool counts; ' +
        'action=migrate imports one session (Codex targets are indexed after backing up the Codex index); ' +
        'action=verify checks a written DSH log; action=drift reports whether the installed DSH session ' +
        'schema still matches this build’s baseline.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'list | preview | migrate | verify | drift',
        },
        adapter: { type: 'string', description: 'Source adapter id for migrate, e.g. codex.' },
        sessionId: { type: 'string', description: 'Source session id for migrate.' },
        to: { type: 'string', description: 'Target adapter id for migrate, e.g. dsh.' },
        cwd: { type: 'string', description: 'Working directory for the imported session; defaults to the source cwd.' },
        dryRun: { type: 'boolean', description: 'Report the plan without writing.' },
        mode: { type: 'string', description: 'Target install mode: direct or staging (default direct for Codex targets).' },
        file: { type: 'string', description: 'Session log path for verify.' },
        limit: { type: 'number', description: 'Maximum sessions returned by list (default 60).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        switch (args.action) {
          case 'list': {
            const rows = await listAll();
            const limit = Math.min(Math.max(Number(args.limit) || 60, 1), 500);
            return {
              summary: summarize(rows),
              sessions: rows.slice(0, limit).map((row) => ({
                adapter: row.adapter,
                sessionId: row.id,
                title: row.title,
                cwd: row.cwd,
                updatedAt: row.updatedAt,
                bytes: row.bytes,
              })),
              truncated: rows.length > limit,
            };
          }
          case 'migrate':
            return migrate({
              adapter: args.adapter,
              sessionId: args.sessionId,
              to: args.to,
              cwd: args.cwd,
              dryRun: args.dryRun === true,
            });
          case 'preview':
            return preview({ adapter: args.adapter, sessionId: args.sessionId });
          case 'verify':
            return verifyDshLog(args.file);
          case 'drift':
            return drift(baseline);
          default:
            return { error: `unknown action: ${args.action}` };
        }
      },
    }),
  );
}
