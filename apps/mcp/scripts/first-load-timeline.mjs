#!/usr/bin/env node
// Joins first-load trials (scripts/first-load-trial.sh) with the server's logs, one timeline per trial (#335).
//
// Usage: node scripts/first-load-timeline.mjs <trials.jsonl> <log.jsonl>...
// Each log file holds JSON lines in any of three forms: the application's own records (`event`, with `at`),
// Railway deployment logs (`railway logs --deployment --json`: `timestamp` and the record in `message`), or Railway
// edge HTTP logs (`railway logs --http --json`: `timestamp`, path, status, duration and bytes).
import {readFileSync} from 'node:fs';

const [trialsFile, ...logFiles] = process.argv.slice(2);
if (!trialsFile || logFiles.length === 0) {
  console.error('usage: node scripts/first-load-timeline.mjs <trials.jsonl> <log.jsonl>...');
  process.exit(2);
}
const lines = file => readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const MARGIN_MS = 5_000;

/** One normalized entry: when, what kind, and the fields worth printing. */
function normalize(raw) {
  const time = Date.parse(raw.timestamp ?? '') || raw.at;
  if (typeof raw.message === 'string' && raw.message.startsWith('{')) {
    try { const record = JSON.parse(raw.message); return {...record, at: record.at ?? time}; } catch { /* plain text line */ }
  }
  if (raw.event) return {...raw, at: time};
  const path = raw.path ?? raw.attributes?.path;
  if (path !== undefined) return {event: 'edge', at: time, ...raw};
  return undefined;
}
const entries = logFiles.flatMap(lines).map(normalize).filter(entry => entry && typeof entry.at === 'number').sort((a, b) => a.at - b.at);
const diagnosticsSeen = entries.some(entry => entry.event === 'view.report');

function describe(entry, zero) {
  const t = `+${((entry.at - zero) / 1000).toFixed(2)}s`.padStart(9);
  switch (entry.event) {
    case 'mcp.request': return `${t} → ${entry.rpc}${entry.uri ? ` ${entry.uri}${entry.uriCurrent === false ? ' (NOT CURRENT)' : ''}` : ''}${entry.client ? ` client=${entry.client}/${entry.clientVersion}` : ''} [${entry.rid}]`;
    case 'mcp.response': return `${t} ← ${entry.rpc} ${entry.status} ${entry.outcome} ${entry.bytes}B headers=${entry.headersMs}ms total=${entry.ms}ms${entry.errorCode === undefined ? '' : ` error=${entry.errorCode}`} [${entry.rid}]`;
    case 'view.report': return `${t} ◆ card ${entry.view} ${entry.reason}${entry.failure ? ` failure=${entry.failure}` : ''} host=${entry.host ?? '?'} origin=${entry.origin} marks=${JSON.stringify(entry.marks)}${entry.errors?.length ? ` errors=${JSON.stringify(entry.errors)}` : ''}`;
    case 'edge': {
      const pick = ['method', 'path', 'httpStatus', 'totalDuration', 'responseTime', 'txBytes', 'rxBytes', 'clientUa', 'responseDetails'];
      return `${t} ▸ edge ${pick.map(key => entry[key] ?? entry.attributes?.[key]).filter(value => value !== undefined).join(' ')}`;
    }
    default: return `${t} · ${entry.event}${entry.rpc ? ` ${entry.rpc}` : ''}${entry.name ? ` ${entry.name}` : ''}${entry.code !== undefined ? ` code=${entry.code}` : ''}`;
  }
}

/** What the window shows, as findings tied to the hypotheses in #335. */
function findings(window) {
  const out = [];
  const reads = window.filter(entry => entry.event === 'mcp.request' && entry.rpc === 'resources/read');
  const readEnds = window.filter(entry => entry.event === 'mcp.response' && entry.rpc === 'resources/read');
  if (reads.length === 0) out.push('no card read reached the server in this window (the host used a cached card, or never asked)');
  if (reads.some(entry => entry.uriCurrent === false)) out.push('a card address that is not the current deploy\'s was read (stale discovery)');
  for (const end of readEnds) if (end.outcome !== 'complete') out.push(`a card read was ${end.outcome} after ${end.ms}ms and ${end.bytes}B`);
  const slow = readEnds.filter(end => end.ms > 2_000);
  if (slow.length) out.push(`card reads slower than 2s: ${slow.map(end => `${end.ms}ms`).join(', ')}`);
  const cards = new Map();
  for (const entry of window.filter(item => item.event === 'view.report')) cards.set(entry.view, entry);
  if (diagnosticsSeen) out.push(`${cards.size} card instance(s) reported`);
  for (const [id, last] of cards) {
    const m = last.marks ?? {};
    if (m.teardownRequested !== undefined && m.ready === undefined) out.push(`card ${id}: the host asked to tear it down before it was ready`);
    if (last.failure) out.push(`card ${id}: start failed (${last.failure})`);
    if (m.ready !== undefined && m.script !== undefined && m.ready - m.script > 3_000) out.push(`card ${id}: ${Math.round(m.ready - m.script)}ms from script start to ready`);
    if (m.hostMessage === undefined) out.push(`card ${id}: no message from the host ever arrived`);
  }
  return out;
}

for (const trial of lines(trialsFile)) {
  const start = Date.parse(trial.start);
  const end = Date.parse(trial.end);
  const window = entries.filter(entry => entry.at >= start - MARGIN_MS && entry.at <= end + MARGIN_MS);
  console.log(`\n=== ${trial.host} / ${trial.deploy} / ${trial.label}: first=${trial.first} retry=${trial.retry} (${trial.start} → ${trial.end})`);
  for (const entry of window) console.log(describe(entry, start));
  for (const finding of findings(window)) console.log(`  ! ${finding}`);
}
