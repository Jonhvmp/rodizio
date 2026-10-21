#!/usr/bin/env node
// The agent: the dashboard server plus the passes. It reacts at once to what matters (a status line sample, a change
// of ~/.claude.json) and otherwise wakes at the next moment worth a look (a window resetting, a reading falling due),
// at least every 10 seconds. launchd keeps it running; the watchdog restarts it if it hangs.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';
import { ClaudeCli } from './claudecli.mjs';
import { Rodizio } from './core.mjs';
import { systemKeychain } from './keychain.mjs';
import { Machines } from './machines.mjs';
import { systemNotify } from './notify.mjs';
import { claudeJsonPath, paths } from './paths.mjs';
import { syncWatchdog } from './install.mjs';
import { createServer } from './server.mjs';
import { ensureConfig, pickPort } from './state.mjs';
import { readRecord, updateInProgress, writeRecord } from './update.mjs';
import { writeJsonAtomic } from './util.mjs';

const TICK_MS = 10_000;
/** A burst of file events (a status line redraw writes several) becomes one pass this soon after the first. */
const NUDGE_MS = 250;
const MIN_WAIT_MS = 250;
const STOP_WAIT_MS = 15_000;
const SELF = fileURLToPath(import.meta.url);
const CLI = path.join(path.dirname(SELF), '..', 'bin', 'rodizio');

const log = {
  info: (m) => console.log(`${new Date().toISOString()} ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ${m}`),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The port is kept whenever possible (bookmarks and the installed app point at it): a previous copy of the agent may
 * still be letting go of it, so it is retried for a few seconds before another one is drawn.
 */
async function listen(core, config, p) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const server = createServer(core, config);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, '127.0.0.1', resolve);
      });
      return server;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      if (attempt < 5) {
        await sleep(1000);
        continue;
      }
      log.error(`a porta ${config.port} continua ocupada por outro programa; sorteando outra`);
      config.port = await pickPort();
      writeJsonAtomic(p.config, config);
    }
  }
  throw new Error('não consegui abrir o painel');
}

/** Whether `pid` is a rodízio agent of this installation (a pid left behind may have been reused by another program). */
function isAgent(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return false;
  }
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (r.status !== 0) return false;
  return r.stdout.includes(SELF) || (r.stdout.includes(CLI) && /\bagente\b/.test(r.stdout));
}

/** One agent per folder: two would both switch accounts and fight over the Keychain. */
function claimSingleInstance(p) {
  const file = path.join(p.home, 'agente.pid');
  let other = 0;
  try {
    other = Number(fs.readFileSync(file, 'utf8').trim());
  } catch {
    // no agent ran here yet
  }
  if (other && other !== process.pid && isAgent(other)) return { ok: false, pid: other };
  fs.writeFileSync(file, String(process.pid), { mode: 0o600 });
  return {
    ok: true,
    release: () => {
      try {
        if (Number(fs.readFileSync(file, 'utf8').trim()) === process.pid) fs.rmSync(file);
      } catch {
        // already gone
      }
    },
  };
}

/** Passes, one at a time: as soon as asked (nudge), or at the next moment the rotation itself asks for. */
export function scheduler(core, { tickMs = TICK_MS, nudgeMs = NUDGE_MS, onError = () => {} } = {}) {
  let timer = null;
  let due = Infinity;
  let running = null;
  let again = false;
  let stopped = false;

  const schedule = (ms) => {
    if (stopped) return;
    const at = Date.now() + ms;
    if (timer && at >= due) return;
    clearTimeout(timer);
    due = at;
    timer = setTimeout(run, Math.max(0, ms));
  };

  async function run() {
    timer = null;
    due = Infinity;
    if (running) {
      again = true;
      return;
    }
    running = core.tick().catch(onError);
    await running;
    running = null;
    if (again) {
      again = false;
      schedule(nudgeMs);
      return;
    }
    const wake = core.nextWakeAt?.();
    const ms = wake ? Math.min(tickMs, Math.max(MIN_WAIT_MS, wake * 1000 - Date.now())) : tickMs;
    schedule(ms);
  }

  return {
    start: () => schedule(0),
    nudge: () => schedule(nudgeMs),
    /** Waits for the pass in progress, so a shutdown never cuts a switch in half. */
    async stop() {
      stopped = true;
      clearTimeout(timer);
      if (running) await running;
    },
  };
}

/** fs.watch is best effort (it can fail or go quiet): the regular beat still covers everything. */
function watch(dir, filter, onEvent) {
  try {
    const w = fs.watch(dir, { persistent: false }, (_, name) => {
      if (!filter || filter(String(name ?? ''))) onEvent();
    });
    w.on('error', () => {});
    return w;
  } catch (e) {
    log.error(`sem aviso imediato de ${dir}: ${e.message}`);
    return null;
  }
}

const UPDATE_POLL_MS = 5000;
const UPDATE_WAIT_MS = 20 * 60_000;

/**
 * After an update: the watchdog's LaunchAgent as the new code expects it, and the news in the history, once. Both
 * wait for the updater to finish: it is still checking this agent (and may be the watchdog, which reloading would
 * stop), and it writes the news only then.
 */
function afterUpdate(core, p) {
  const started = Date.now();
  const done = () => {
    try {
      const changed = syncWatchdog();
      if (changed) log.info(`vigia ${changed} para esta versão`);
    } catch (e) {
      log.error(`vigia: ${e.message}`);
    }
    const rec = readRecord(p.home);
    if (rec.last && !rec.last.seen) {
      const l = rec.last;
      core.event(l.ok ? 'info' : 'erro', l.ok ? `Atualizado de ${l.from} para ${l.to}.${l.notes ? ` ${l.notes.split('\n')[0]}` : ''}` : `A atualização para ${l.to} não deu certo: ${l.why}`);
      writeRecord(p.home, { last: { ...l, seen: true } });
    }
  };
  const wait = () => {
    if (updateInProgress(p.home) && Date.now() - started < UPDATE_WAIT_MS) setTimeout(wait, UPDATE_POLL_MS).unref();
    else done();
  };
  wait();
}

export async function startAgent({ demo = process.env.RODIZIO_DEMO === '1' } = {}) {
  const p = paths();
  for (const d of [p.home, p.accounts, p.samples, p.logs]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const claim = claimSingleInstance(p);
  if (!claim.ok) {
    log.error(`outro agente do rodízio já está rodando (pid ${claim.pid}); este sai sem fazer nada`);
    process.exit(0);
  }
  process.on('exit', claim.release);
  const config = await ensureConfig(p);
  const deps = demo
    ? (await import('./demo.mjs')).demoDeps(p)
    : { kc: systemKeychain({ accountsDir: p.accounts }), api: createApi(), cli: new ClaudeCli(), claudeJson: claudeJsonPath(), notify: systemNotify() };
  const core = new Rodizio({ paths: p, config, log, ...deps });
  // Other computers with a rodízio of their own, watched over SSH (none in the demo: it would call real machines).
  if (!demo) {
    core.machines = new Machines({ home: p.home, onChange: () => core.changed(), log });
    core.machines.start();
  }
  if (!demo) afterUpdate(core, p);
  const server = await listen(core, config, p);
  log.info(`rodízio ${demo ? '(demonstração) ' : ''}no ar: http://rodizio.localhost:${config.port}/`);

  const beat = scheduler(core, { onError: (e) => log.error(`passada: ${e.stack ?? e}`) });
  // A status line sample is a fresh reading of the account in use; a change of ~/.claude.json may be a /login.
  const watchers = [
    watch(p.samples, (name) => name.endsWith('.json'), beat.nudge),
    watch(path.dirname(core.claudeJson), (name) => name === path.basename(core.claudeJson), beat.nudge),
  ];
  beat.start();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const w of watchers) w?.close();
    core.machines?.stop();
    server.close();
    const forced = setTimeout(() => process.exit(0), STOP_WAIT_MS);
    try {
      await beat.stop();
      await core.mutex.run(() => {});
      core.save();
    } finally {
      clearTimeout(forced);
      process.exit(0);
    }
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return { core, server, beat };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF)) {
  startAgent().catch((e) => {
    log.error(e.stack ?? String(e));
    process.exit(1);
  });
}
