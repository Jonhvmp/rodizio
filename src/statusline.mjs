#!/usr/bin/env node
// Claude Code status line: shows the account in use and hands the session's rate limits to the agent, which credits
// them to that account. It must stay fast and never fail.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './paths.mjs';
import { readJson, writeJsonAtomic } from './util.mjs';

const C = { dim: '\x1b[2m', reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };

const color = (pct) => (pct >= 90 ? C.red : pct >= 70 ? C.yellow : C.green);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What the agent needs from one redraw: the limits, and the session's running totals (cost, tokens, lines). */
export function recordSample(p, j, now = Math.floor(Date.now() / 1000)) {
  const sessionId = String(j?.session_id ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!sessionId) return false;
  const rl = j?.rate_limits;
  const kept = rl && (rl.seven_day || rl.five_hour) ? { five_hour: rl.five_hour ?? null, seven_day: rl.seven_day ?? null } : null;
  const c = j?.cost ?? {};
  const cw = j?.context_window ?? {};
  writeJsonAtomic(path.join(p.samples, `${sessionId}.json`), {
    at: now,
    sessionId,
    rl: kept,
    sig: kept ? JSON.stringify(kept) : null,
    totals: {
      cost: num(c.total_cost_usd),
      tokensIn: num(cw.total_input_tokens),
      tokensOut: num(cw.total_output_tokens),
      linesAdded: num(c.total_lines_added),
      linesRemoved: num(c.total_lines_removed),
    },
    model: typeof j?.model?.display_name === 'string' ? j.model.display_name : null,
    ctx: num(cw.used_percentage),
  });
  return true;
}

export function render(p, j) {
  const st = readJson(p.state, {});
  const acc = st?.accounts?.[st?.active];
  const sep = `${C.dim} · ${C.reset}`;
  const parts = [];
  if (j?.model?.display_name) parts.push(`${C.dim}${j.model.display_name}${C.reset}`);
  parts.push(acc ? `${C.cyan}⇄ ${acc.email}${C.reset}${acc.plan?.label ? ` ${C.dim}${acc.plan.label}${C.reset}` : ''}` : `${C.dim}⇄ conta fora do rodízio${C.reset}`);
  const w = j?.rate_limits?.seven_day?.used_percentage;
  const f = j?.rate_limits?.five_hour?.used_percentage;
  if (typeof w === 'number') parts.push(`semana ${color(w)}${Math.round(w)}%${C.reset}`);
  if (typeof f === 'number') parts.push(`5h ${color(f)}${Math.round(f)}%${C.reset}`);
  const ctx = j?.context_window?.used_percentage;
  if (typeof ctx === 'number') parts.push(`${C.dim}contexto ${Math.round(ctx)}%${C.reset}`);
  return parts.join(sep);
}

function main(input) {
  const p = paths();
  let j = {};
  try {
    j = JSON.parse(input || '{}');
  } catch {
    // an unreadable payload still gets a line
  }
  try {
    fs.mkdirSync(p.samples, { recursive: true, mode: 0o700 });
    recordSample(p, j);
  } catch {
    // the line matters more than the sample
  }
  try {
    process.stdout.write(render(p, j));
  } catch {
    process.stdout.write('⇄ rodízio');
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => main(input));
}
