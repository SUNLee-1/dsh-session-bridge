#!/usr/bin/env node
/**
 * Minimal MCP stdio server exposing the bridge to any MCP-capable agent
 * (Codex, Claude Code, …). No dependencies: newline-delimited JSON-RPC 2.0.
 */
import readline from 'node:readline';
import fs from 'node:fs';
import { listAll, summarize, migrate, verifyDshLog } from '../lib/engine.mjs';
import { drift } from '../lib/dsh-schema.mjs';

const baseline = JSON.parse(fs.readFileSync(new URL('../schema/baseline.json', import.meta.url), 'utf8'));
const PROTOCOL = '2024-11-05';

const TOOLS = [
  {
    name: 'session_bridge_list',
    description: 'List coding-agent sessions visible to the installed adapters (Codex, DSH).',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'session_bridge_migrate',
    description:
      'Import one session into another agent store. Codex is read-only; DSH is the writable target. Only new files are created.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'source adapter id, e.g. codex' },
        sessionId: { type: 'string' },
        to: { type: 'string', description: 'target adapter id, default dsh' },
        cwd: { type: 'string' },
        dryRun: { type: 'boolean' },
      },
      required: ['from', 'sessionId'],
    },
  },
  {
    name: 'session_bridge_verify',
    description: 'Structurally verify a written DSH session log (frames, header, contiguous seq).',
    inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
  },
  {
    name: 'session_bridge_drift',
    description: 'Report whether the installed DSH session schema still matches this build’s baseline.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function call(name, args = {}) {
  switch (name) {
    case 'session_bridge_list': {
      const rows = await listAll();
      const limit = Math.min(Math.max(Number(args.limit) || 60, 1), 500);
      return {
        summary: summarize(rows),
        sessions: rows.slice(0, limit).map((row) => ({
          adapter: row.adapter,
          sessionId: row.id,
          title: row.title,
          cwd: row.cwd,
          bytes: row.bytes,
          updatedAt: row.updatedAt,
        })),
      };
    }
    case 'session_bridge_migrate':
      return migrate({
        adapter: args.from,
        sessionId: args.sessionId,
        to: args.to ?? 'dsh',
        cwd: args.cwd,
        dryRun: args.dryRun === true,
      });
    case 'session_bridge_verify':
      return verifyDshLog(args.file);
    case 'session_bridge_drift':
      return drift(baseline);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (line.trim().length === 0) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-session-bridge', version: '1.0.0' },
    });
    return;
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    try {
      const value = await call(params?.name, params?.arguments ?? {});
      reply(id, { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
    } catch (error) {
      reply(id, { content: [{ type: 'text', text: JSON.stringify({ error: String(error?.message ?? error) }) }], isError: true });
    }
    return;
  }
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (id !== undefined) fail(id, -32601, `unknown method: ${method}`);
});
