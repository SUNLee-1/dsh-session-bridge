/**
 * The canonical event stream every adapter reads and writes.
 *
 * Adapters translate their own records to and from these plain objects. It is
 * deliberately flat and string-based so a source record can be mapped once and
 * handed straight to a writer without an intermediate tree.
 */
import { createHash } from 'node:crypto';

/** @typedef {'meta'|'title'|'turn/start'|'turn/end'|'step/start'|'step/end'|'user'|'assistant'|'tool/call'|'tool/result'|'usage'} EventKind */

export const K = Object.freeze({
  meta: 'meta',
  title: 'title',
  turnStart: 'turn/start',
  turnEnd: 'turn/end',
  stepStart: 'step/start',
  stepEnd: 'step/end',
  user: 'user',
  assistant: 'assistant',
  toolCall: 'tool/call',
  toolResult: 'tool/result',
  usage: 'usage',
});

/**
 * Stable identity for duplicate detection across harnesses.
 * Uses the source id, creation time and the first user text, so the same
 * conversation imported twice is detected without hashing whole transcripts.
 * @param {{id?:string, createdAt?:number}} meta
 * @param {string} firstUserText
 */
export function fingerprint(meta, firstUserText) {
  return createHash('sha256')
    .update(`${meta?.id ?? ''}\u0000${meta?.createdAt ?? 0}\u0000${(firstUserText ?? '').slice(0, 400)}`)
    .digest('hex')
    .slice(0, 16);
}

/** Collapse whitespace for previews and titles. */
export function oneLine(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Harness-injected context arrives as a user message but is not conversation.
 * Importing it would duplicate runtime noise in the other harness.
 */
const SYNTHETIC_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '<system-reminder>',
  '<turn_aborted>',
  '<INSTRUCTIONS>',
  'Current runtime context.',
  '# AGENTS.md',
];

export function isSyntheticContext(text) {
  const head = String(text ?? '').trimStart();
  return SYNTHETIC_PREFIXES.some((prefix) => head.startsWith(prefix));
}
