/**
 * DSH's own persistence schema, read from the running installation.
 *
 * The schema is the authority for what an event line must contain, so required
 * fields are derived from it at runtime instead of being hard-coded. When a DSH
 * upgrade changes those digests, `drift` reports it and the writer immediately
 * follows the new requirements — that is the whole update-adaptation story.
 *
 * The 220 KB document is parsed once and reduced to a small map; the parsed
 * document is then released so it does not stay resident.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installDir } from './install.mjs';

let cached;

/** @param {string} [installDir] */
export function schemaPath(base = installDir()) {
  if (!base) return undefined;
  const file = path.join(base, 'docs', 'persistence-schema.json');
  return fs.existsSync(file) ? file : undefined;
}

function requiredFields(node) {
  return (node?.properties ?? []).filter((p) => !p.optional).map((p) => p.name);
}

/**
 * @param {string} [installDir]
 * @returns {{formatVersion:number, digest:string, header:string[], events:Record<string,{envelope:string[],data:string[]}>}|undefined}
 */
export function loadSchema(base) {
  if (cached !== undefined) return cached;
  const file = schemaPath(base);
  if (!file) {
    cached = undefined;
    return undefined;
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    cached = undefined;
    return undefined;
  }
  const nodes = doc.nodes ?? {};
  const nodeFor = (digest) => nodes[String(digest).slice(0, 16)];
  const header = [];
  const events = {};
  const fingerprints = [];
  for (const root of doc.roots ?? []) {
    fingerprints.push(`${root.key}:${root.digest}`);
    const node = nodeFor(root.digest);
    if (!node) continue;
    if (root.key === 'SessionHeader') header.push(...requiredFields(node));
    if (root.kind === 'event' && root.event) {
      const data = node.properties?.find((p) => p.name === 'data');
      events[root.event] = {
        envelope: requiredFields(node),
        data: requiredFields(nodes[data?.type]),
      };
    }
  }
  cached = {
    formatVersion: doc.formatVersion ?? 0,
    digest: createHash('sha256').update(fingerprints.sort().join('\n')).digest('hex'),
    header,
    events,
  };
  doc = undefined; // release the full tree
  return cached;
}

/**
 * Compare the installed schema with the baseline this build was written against.
 * @param {{formatVersion:number, digest:string}} baseline
 * @param {string} [installDir]
 */
export function drift(baseline, base) {
  const live = loadSchema(base);
  if (!live) return { status: 'unavailable', detail: 'installed persistence schema not found' };
  if (!baseline?.digest) return { status: 'unbaselined', live };
  if (live.digest === baseline.digest && live.formatVersion === baseline.formatVersion) {
    return { status: 'match', live };
  }
  return {
    status: 'changed',
    detail: `baseline ${baseline.formatVersion}/${baseline.digest.slice(0, 12)} vs installed ${live.formatVersion}/${live.digest.slice(0, 12)}`,
    live,
  };
}
