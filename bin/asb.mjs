#!/usr/bin/env node
/**
 * asb — command line front end for the same engine the DSH panel uses.
 *
 * Run it from a checkout or through the installed bundle; it needs no
 * dependencies and no network.
 */
import { listAll, summarize, migrate, verifyDshLog, loadAdapters } from '../lib/engine.mjs';
import { drift } from '../lib/dsh-schema.mjs';
import { installDir, electronBinary, codexHome, dshHome } from '../lib/install.mjs';
import { hasNativeZstd } from '../lib/zstd.mjs';
import { ensureBridge, bridgeConfig } from '../lib/bridge.mjs';
import fs from 'node:fs';

const baseline = JSON.parse(fs.readFileSync(new URL('../schema/baseline.json', import.meta.url), 'utf8'));

function options(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function table(rows) {
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  return rows
    .map((row) => {
      const size = row.bytes >= 1048576 ? `${(row.bytes / 1048576).toFixed(1)}MB` : `${Math.round(row.bytes / 1024)}KB`;
      return (
        `${row.adapter.padEnd(6)} ${row.sessionId.slice(0, 22).padEnd(22)} ` +
        `${clip(row.title || '(untitled)', 46).padEnd(46)}  ${size.padStart(7)}  ${row.cwd}`
      );
    })
    .join('\n');
}

async function main(argv) {
  const [command, ...rest] = argv;
  const flags = options(rest);

  switch (command) {
    case 'list': {
      const rows = await listAll();
      if (flags.json) {
        process.stdout.write(`${JSON.stringify({ summary: summarize(rows), sessions: rows }, null, 2)}\n`);
        return 0;
      }
      if (rows.length === 0) {
        process.stdout.write('No sessions found in any installed adapter.\n');
        return 0;
      }
      process.stdout.write(
        table(rows.map((row) => ({ ...row, sessionId: row.id }))) + `\n\n${rows.length} sessions\n`,
      );
      return 0;
    }
    case 'adapters': {
      const adapters = await loadAdapters();
      for (const adapter of adapters.values()) {
        process.stdout.write(`${adapter.id.padEnd(8)} writes=${adapter.writes}\n`);
      }
      return 0;
    }
    case 'migrate': {
      const from = flags.from;
      const id = flags.id;
      const to = flags.to ?? 'dsh';
      if (!from || !id) {
        process.stderr.write('usage: asb migrate --from codex --id <session-id> [--to dsh] [--cwd DIR] [--dry-run]\n');
        return 2;
      }
      const result = await migrate({
        adapter: from,
        sessionId: id,
        to,
        cwd: typeof flags.cwd === 'string' ? flags.cwd : undefined,
        dryRun: flags['dry-run'] === true,
        force: flags.force === true,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }
    case 'verify': {
      const file = flags._[0];
      if (!file) {
        process.stderr.write('usage: asb verify <session.v4.jsonl.zstd>\n');
        return 2;
      }
      const result = await verifyDshLog(file);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }
    case 'init': {
      const config = {
        bridge: {
          enabled: flags['no-dsh'] !== true && flags.disable !== true,
          path: typeof flags.path === 'string' ? flags.path : '',
          name: typeof flags.name === 'string' ? flags.name : '',
        },
      };
      const target = bridgeConfig(config);
      process.stdout.write(`bridge folder: ${target.dir}\n`);
      const result = await ensureBridge({ config });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.dsh?.restartRequired) {
        process.stdout.write(
          'DSH is not reachable from a plain shell, so the workspace was written to its registry.\n' +
            'Quit DeepSeek Harness before running this, or run it from inside DSH, or the app may\n' +
            'overwrite the registry. Restart DSH once for the workspace to appear.\n',
        );
      }
      if (result.codex?.created) {
        process.stdout.write('Codex must be restarted before the project appears.\n');
      }
      return result.enabled ? 0 : 1;
    }
    case 'doctor': {
      const checks = [
        ['platform', `${process.platform} ${process.arch}`],
        ['node', process.version],
        ['native zstd', hasNativeZstd() ? 'yes' : 'no (needs Node >= 22.15)'],
        ['fallback runtime', electronBinary() ?? 'not found'],
        ['DSH install', installDir() ?? 'not found'],
        ['DSH home', `${dshHome()}${fs.existsSync(dshHome()) ? '' : ' (missing)'}`],
        ['Codex home', `${codexHome()}${fs.existsSync(codexHome()) ? '' : ' (missing)'}`],
      ];
      const schema = drift(baseline);
      checks.push(['DSH schema', `${schema.status}${schema.detail ? ` — ${schema.detail}` : ''}`]);
      for (const [name, value] of checks) process.stdout.write(`${name.padEnd(16)} ${value}\n`);
      const ok = hasNativeZstd() || electronBinary() !== undefined;
      process.stdout.write(`\n${ok ? 'can read and write session logs' : 'cannot encode zstd: install DSH or use Node >= 22.15'}\n`);
      return ok ? 0 : 1;
    }
    case 'drift': {
      const result = drift(baseline);
      process.stdout.write(`${JSON.stringify({ status: result.status, detail: result.detail ?? null }, null, 2)}\n`);
      return result.status === 'match' ? 0 : 1;
    }
    default:
      process.stdout.write(
        'asb — agent session bridge\n\n' +
          '  asb list [--json]                       list sessions from every adapter\n' +
          '  asb adapters                            show installed adapters\n' +
          '  asb migrate --from codex --id ID        import one session (default target: dsh)\n' +
          '              [--to dsh] [--cwd DIR] [--dry-run] [--force]\n' +
          '  asb verify <file>                       check a written DSH session log\n' +
          '  asb drift                               compare installed DSH schema with the baseline\n' +
          '  asb doctor                              report what this machine can do\n' +
          '  asb init [--path DIR] [--name NAME]     create the shared bridge project on both sides\n',
      );
      return command ? 2 : 0;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
