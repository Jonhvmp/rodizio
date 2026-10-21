// The rotation: who is in Claude Code now, switching, usage readings and the accounts themselves.
//
// Rules that keep a login from being lost:
// - only the profile endpoint says whose token is in the main item (reading it does not rotate the token); without
//   an answer the agent waits instead of guessing from ~/.claude.json;
// - the main item is the live copy of the account in use (its sessions refresh the token there, and refresh tokens
//   rotate), so its token is mirrored into that account's own item whenever it changes;
// - the main item is re-read right before every write, and a write is skipped when it changed in between;
// - a pass only counts a main-item token as seen after everything it had to write for it succeeded;
// - a parked account's own item may be renewed through Claude Code; the item of the account in use never is;
// - a login in the main item whose owner is not in the rotation is never overwritten.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usageFromStatusline } from './api.mjs';
import { expiresAtS, hasRefresh, loginOnly, oauth, planOf, tokenHash, withLogin } from './blob.mjs';
import { readOauthAccount, writeOauthAccount } from './claudejson.mjs';
import { RETURN_GAP_S, SWITCH_GAP_S, decide, effPct, fiveHourOf, fiveHourTriggerOf, nextCandidate, priority, triggerOf, weeklyOf, zoneOf } from './decide.mjs';
import { addActivity, capacityOf, insights, recordHistory, setActive, totalsDelta } from './insights.mjs';
import { consume, forget, observe } from './learn.mjs';
import { MAIN_SERVICE, serviceForDir } from './keychain.mjs';
import { LoginJob } from './logins.mjs';
import { CONFIG_KEYS, PCT_KEYS, backupPath, loadState } from './state.mjs';
import { currentVersion, readRecord, updateInProgress } from './update.mjs';
import { Mutex, nowS, readJson, writeJsonAtomic } from './util.mjs';

/** Without a readable ~/.claude.json, a write-back of an account switched out this recently is taken as stale. */
export const STALE_WINDOW_S = 120;
/** Status line numbers right after a switch may still come from the old account. */
export const SAMPLE_GRACE_S = 45;
/** A stale write-back is confirmed on a later pass at least this long after it was first seen. */
export const STALE_CONFIRM_S = 5;
export const ACTIVE_POLL_S = 120;
/** Near a zone (this many points short of it), the account in use is read much more often. */
export const NEAR_POINTS = 10;
export const NEAR_POLL_S = 45;
export const PARKED_POLL_S = 900;
export const RENEW_BEFORE_S = 300;
/** A parked account's token is renewed this long before it expires, so a switch never waits on a renewal. */
export const RENEW_AHEAD_S = 1800;
export const RENEW_RETRY_S = 3600;
const SAMPLE_MAX_AGE_S = 86_400;
const REDO_WINDOW_S = 600;
const MAX_REDO = 3;
const MAX_EVENTS = 300;
/** Bumped whenever the dashboard needs something new from the agent; the page compares it with its own. */
export const API_VERSION = 4;
/** The version this agent runs, read once: an update restarts the agent. */
const AGENT_VERSION = currentVersion();
/** Two resets_at closer than this are the same week. */
const SAME_RESET_S = 120;
/** A session still answering from the previous account this long after a switch is reported. */
export const HANDOVER_STUCK_S = 180;
/** A first 401 is asked again after this long, to confirm it. */
const UNAUTHORIZED_RECHECK_S = 120;
const RECHECK_REFUSED_S = 3600;
/** A Retry-After (from the usage or the profile endpoint) is honored up to this long. */
const MAX_RETRY_AFTER_S = 3600;
const MAX_BACKOFF_S = 1800;
const BACKUP_EVERY_S = 300;

/** A path as shown on the dashboard: the home folder as ~, so a screenshot does not carry the user name. */
export function displayPath(p) {
  const home = os.homedir();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

export class Rodizio {
  constructor({ paths, config, kc, api, cli, claudeJson, clock = nowS, notify = () => {}, log = console }) {
    Object.assign(this, { p: paths, config, kc, api, cli, claudeJson, clock, notify, log });
    this.state = loadState(paths);
    this.saved = JSON.stringify(this.state);
    this.mutex = new Mutex();
    this.jobs = new Map();
    this.lastWarn = new Map();
    /**
     * When the usage endpoint last answered 200, per account: a 401 for one account only means its login was refused
     * when another account was answered recently (otherwise it may be the endpoint, or the network).
     */
    this.apiOkAt = {};
    this.backupAt = 0;
    /** The last decision, for the dashboard (waiting on a 5-hour reset, holding after too many switches). */
    this.decision = { kind: 'none' };
    /** Who wants to know the moment something changes (the dashboard's live stream). */
    this.listeners = new Set();
  }

  now() {
    return this.clock();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        this.log.error?.(`aviso de mudança: ${e.message}`);
      }
    }
  }

  save() {
    const s = JSON.stringify(this.state);
    if (s === this.saved) return false;
    writeJsonAtomic(this.p.state, this.state);
    this.saved = s;
    // A copy at most every few minutes, for the day state.json cannot be read (see loadState).
    if (this.now() - this.backupAt >= BACKUP_EVERY_S) {
      writeJsonAtomic(backupPath(this.p), this.state);
      this.backupAt = this.now();
    }
    this.changed();
    return true;
  }

  /** Whether the endpoint answered another account at or after `since`. */
  apiOkElsewhere(id, since) {
    return Object.entries(this.apiOkAt).some(([k, at]) => k !== id && at >= since);
  }

  saveConfig() {
    writeJsonAtomic(this.p.config, this.config);
    this.changed();
  }

  /** How often an account's usage is read from the API: often near a zone of the account in use, rarely when parked. */
  pollEvery(acc, active, now = this.now()) {
    if (!active) return PARKED_POLL_S;
    const w = weeklyOf(acc, now);
    const f = fiveHourOf(acc, now);
    const near =
      (w !== null && w >= triggerOf(this.config) - NEAR_POINTS) ||
      (this.config.fiveHourSwitch && f !== null && f >= fiveHourTriggerOf(this.config) - NEAR_POINTS);
    return near ? NEAR_POLL_S : ACTIVE_POLL_S;
  }

  /**
   * The next moment worth a pass, so nothing waits for the regular beat: a window resetting (a return to the
   * preferred account), a wait or a gap between switches ending, a reading or a backoff falling due.
   */
  nextWakeAt() {
    const st = this.state;
    const now = this.now();
    const times = [];
    const add = (t) => {
      if (typeof t === 'number' && t > now) times.push(t);
    };
    for (const a of Object.values(st.accounts)) {
      add(a.usage?.weekly?.resetsAt);
      add(a.usage?.fiveHour?.resetsAt);
      const active = a.id === st.active;
      if (this.config.useApi && !a.needsLogin && (active || this.config.pollParked)) {
        add(Math.max((a.apiAt ?? 0) + this.pollEvery(a, active, now), a.apiBackoffUntil ?? 0));
      }
    }
    if (this.decision.kind === 'wait') add(this.decision.until);
    add((st.lastSwitchAt ?? 0) + SWITCH_GAP_S);
    add((st.lastSwitchAt ?? 0) + RETURN_GAP_S);
    return times.length ? Math.min(...times) + 1 : null;
  }

  event(kind, text, extra = {}) {
    this.state.events.unshift({ at: this.now(), kind, text, ...extra });
    if (this.state.events.length > MAX_EVENTS) this.state.events.length = MAX_EVENTS;
    this.log.info?.(`[${kind}] ${text}`);
  }

  /** Logs every failure, but records it in the history only when the message changes. */
  warn(key, e) {
    const msg = e?.message ?? String(e);
    this.log.error?.(`${key}: ${msg}`);
    if (this.lastWarn.get(key) === msg) return;
    this.lastWarn.set(key, msg);
    this.event('erro', msg);
  }

  byUuid(uuid) {
    return uuid ? (Object.values(this.state.accounts).find((a) => a.uuid === uuid) ?? null) : null;
  }

  svc(acc) {
    return serviceForDir(acc.dir);
  }

  label(acc, now = this.now()) {
    const p = weeklyOf(acc, now);
    return p === null ? acc.email : `${acc.email} (${Math.round(p)}%)`;
  }

  locked(fn) {
    return this.mutex.run(fn).finally(() => this.save());
  }

  /** Every change of the account in use goes through here, so the baton timeline stays complete. */
  setActive(id) {
    this.state.active = id;
    setActive(this.state, id, this.now());
  }

  // ------------------------------------------------------------------------------------------------- loop

  /** One pass: who is in Claude Code, new readings, then the decision. */
  tick() {
    return this.locked(async () => {
      observe(this.state, this.now()); // the agent was watching: an hour with nothing spent is learned as idle
      try {
        await this.reconcile();
        this.lastWarn.delete('reconcile');
      } catch (e) {
        this.warn('reconcile', e);
        return;
      }
      this.ingestSamples();
      await this.pollUsage();
      await this.act();
    });
  }

  async act() {
    const st = this.state;
    const now = this.now();
    if (st.mainPending) return; // who is in Claude Code is not known yet
    const d = decide(st, this.config, now);
    this.decision = d;
    if (d.kind === 'exhausted') {
      if (!st.exhaustedAt) {
        st.exhaustedAt = now;
        const text =
          d.window === 'weekly'
            ? 'Todas as contas estão no limite da semana; fico na atual até alguma renovar.'
            : d.window === 'fiveHour'
              ? 'Nenhuma conta tem folga na janela de 5 h e na semana ao mesmo tempo; fico na atual até alguma renovar.'
              : 'Nenhuma outra conta pode receber o bastão agora (fora da fila, sem folga ou precisando entrar de novo).';
        this.event('alerta', text, { window: d.window });
        if (this.config.notify) this.notify('Rodízio de contas', text);
      }
      return;
    }
    st.exhaustedAt = 0;
    if (d.kind === 'throttled') {
      if (!st.throttledAt || now - st.throttledAt > 3600) {
        st.throttledAt = now;
        this.event('alerta', `Foram ${d.count} trocas automáticas na última hora; seguro as próximas até a hora passar. Veja se alguma leitura está errada.`);
        if (this.config.notify) this.notify('Rodízio de contas', 'Trocas demais em pouco tempo: segurei as automáticas por enquanto.');
      }
      return;
    }
    if (d.kind !== 'switch') return;
    try {
      await this.doSwitch(d.to, d.reason, { window: d.window });
      this.lastWarn.delete('switch');
    } catch (e) {
      this.warn('switch', e);
    }
  }

  // ------------------------------------------------------------------------------- who is in Claude Code

  async reconcile() {
    const st = this.state;
    const now = this.now();
    const main = await this.kc.read(MAIN_SERVICE);
    const oa = readOauthAccount(this.claudeJson); // undefined: the file did not parse right now
    if (oa !== undefined) st.mainEmail = oa?.emailAddress ?? null;
    await this.repairOauthAccount(oa);
    const h = tokenHash(main);
    if (!h) {
      if (st.active) this.event('aviso', 'O Claude Code ficou sem login; nenhuma conta em uso.');
      this.setActive(null);
      st.mainHash = null;
      st.mainPending = false;
      return;
    }
    if (h === st.mainHash) return;
    st.mainPending = true;
    const owner = await this.identify(main);
    if (owner === undefined) return; // no answer from the profile: the next pass asks again
    if (owner === null) {
      if (st.active) this.event('aviso', `O Claude Code entrou em ${oa?.emailAddress ?? 'uma conta'}, que não está no rodízio.`);
      this.setActive(null);
      this.seen(h);
      return;
    }
    const acc = st.accounts[owner];
    const active = st.accounts[st.active];

    if (active && owner !== active.id && this.isStaleWriteBack(acc, active, oa, now)) {
      // A session still holding the old account's token refreshed it and wrote it over the account in use. That
      // token is now the old account's only valid one: keep it, then put the account in use back. Seen twice first,
      // because a real /login writes the Keychain an instant before ~/.claude.json.
      if (st.staleSeen?.h !== h) {
        st.staleSeen = { h, at: now };
        return;
      }
      if (now - st.staleSeen.at < STALE_CONFIRM_S) return;
      st.redoLog = (st.redoLog ?? []).filter((t) => now - t < REDO_WINDOW_S);
      if (st.redoLog.length < MAX_REDO) {
        await this.mirror(acc, main);
        await this.install(active, { expect: h });
        st.redoLog.push(now);
        st.staleSeen = null;
        st.mainPending = false;
        this.event('info', `Uma sessão regravou o login de ${acc.email} por cima de ${active.email}; guardei o dela e refiz a troca.`);
        await this.writeOauthAccountOf(active);
        return;
      }
      this.event('aviso', `Regravações seguidas de ${acc.email}; aceito que ela está em uso.`);
    }
    st.staleSeen = null;

    await this.mirror(acc, main);
    if (oa && oa.accountUuid !== acc.uuid) await this.writeOauthAccountOf(acc);
    if (owner !== st.active) {
      const adopted = !st.active;
      this.setActive(owner);
      st.activeSince = now;
      st.pinned = !adopted;
      this.event(
        adopted ? 'info' : 'troca',
        adopted
          ? `${acc.email} está no Claude Code e passou a ser a conta em uso do rodízio.`
          : `O Claude Code passou para ${acc.email} por fora do rodízio (login manual).`,
        { to: owner },
      );
    }
    this.seen(h);
  }

  /** The main-item token `h` is handled; only called once every write for it succeeded. */
  seen(h) {
    this.state.mainHash = h;
    this.state.mainPending = false;
  }

  /**
   * A session's refresh rewrites the token but not ~/.claude.json, which still names the account in use; a /login
   * rewrites both. Without a readable ~/.claude.json, only a write-back right after a switch counts as stale.
   */
  isStaleWriteBack(acc, active, oa, now) {
    if (oa?.accountUuid) return oa.accountUuid === active.uuid && oa.accountUuid !== acc.uuid;
    const leftAt = this.state.recentFrom[acc.id];
    return !!leftAt && now - leftAt < STALE_WINDOW_S;
  }

  /** Account id of the login in the main item; null when it is not in the rotation, undefined when unsure. */
  async identify(main) {
    const h = tokenHash(main);
    const known = Object.values(this.state.accounts).find((a) => a.lastHash === h);
    if (known) return known.id;
    // ~/.claude.json would only be a guess: a session may write back the previous account's token while the file
    // already names the new one. A profile that does not answer is asked again later, not on every pass.
    const now = this.now();
    const wait = this.profileWait;
    if (wait?.hash === h && now < wait.until) return undefined;
    const r = await this.api.profile(oauth(main).accessToken);
    if (r.status === 200) {
      this.profileWait = null;
      return this.byUuid(r.uuid)?.id ?? null;
    }
    const failures = wait?.hash === h ? wait.failures + 1 : 1;
    this.profileWait = { hash: h, failures, until: now + Math.min(MAX_RETRY_AFTER_S, r.retryAfter ?? Math.min(600, 15 * 2 ** (failures - 1))) };
    return undefined;
  }

  /** Copies the live token of the account in use into its own item. */
  async mirror(acc, main) {
    const h = tokenHash(main);
    if (!h) return;
    const svc = this.svc(acc);
    const stored = await this.kc.read(svc);
    // Only the token: organizationUuid in the main item may be the other account's after a session's write-back.
    if (tokenHash(stored) !== h) await this.kc.write(svc, { ...(stored ?? {}), claudeAiOauth: main.claudeAiOauth });
    // Only a new token clears a refused login: copying the same refused one back is no evidence it works again.
    if (acc.lastHash !== h) {
      acc.needsLogin = false;
      acc.unauthorized = 0;
    }
    acc.lastHash = h;
    acc.tokenExpiresAt = expiresAtS(main);
    acc.plan = planOf(main) ?? acc.plan;
  }

  /**
   * Puts the account's own login into the main item, keeping everything else there. `expect` is the main-item token
   * hash the caller decided on; if the item changed since, nothing is written.
   */
  async install(acc, { expect }) {
    const blob = await this.kc.read(this.svc(acc));
    if (!hasRefresh(blob)) {
      acc.needsLogin = true;
      throw new Error(`${acc.email} está sem login guardado; reconecte pelo painel.`);
    }
    const fresh = await this.kc.read(MAIN_SERVICE);
    if ((tokenHash(fresh) ?? null) !== (expect ?? null)) {
      throw new Error('O login do Claude Code mudou durante a troca; tento de novo na próxima passada.');
    }
    const next = withLogin(fresh, loginOnly(blob));
    await this.kc.write(MAIN_SERVICE, next);
    acc.lastHash = tokenHash(next);
    this.seen(acc.lastHash);
    // ~/.claude.json is the caller's to write, after its own state says who is in use: nothing awaited may sit
    // between the Keychain write and that, or a shutdown in between would save a switch half done.
  }

  /** ~/.claude.json names the account; a failure is retried on later passes instead of undoing the switch. */
  async writeOauthAccountOf(acc) {
    const oa = readOauthAccount(path.join(acc.dir, '.claude.json'));
    if (!oa) return;
    try {
      await writeOauthAccount(this.claudeJson, oa);
      if (this.state.oaRepair === acc.id) this.state.oaRepair = null;
    } catch (e) {
      this.state.oaRepair = acc.id;
      this.warn('oauthAccount', e);
    }
  }

  async repairOauthAccount(oa) {
    const id = this.state.oaRepair;
    if (!id) return;
    const acc = this.state.accounts[id];
    if (!acc || id !== this.state.active) {
      this.state.oaRepair = null;
      return;
    }
    if (oa?.accountUuid !== acc.uuid) await this.writeOauthAccountOf(acc);
    else this.state.oaRepair = null;
  }

  async renewParked(acc) {
    if (acc.id === this.state.active) return null;
    const before = await this.kc.read(this.svc(acc));
    acc.renewTriedAt = this.now();
    const r = await this.cli.renew(acc.dir);
    try {
      if (JSON.parse(r.out || 'null')?.loggedIn === false) {
        acc.needsLogin = true;
        this.event('erro', `${acc.email}: o Claude Code diz que o login guardado não vale mais; reconecte pelo painel.`);
        return null;
      }
    } catch {
      // not JSON: judge by the token alone
    }
    const after = await this.kc.read(this.svc(acc));
    if (expiresAtS(after) <= expiresAtS(before)) return null;
    acc.tokenExpiresAt = expiresAtS(after);
    acc.lastHash = tokenHash(after);
    return after;
  }

  // ------------------------------------------------------------------------------------------------ switch

  /** A switch asked for by hand. */
  switchTo(id, reason) {
    return this.locked(() => this.doSwitch(id, reason, { manual: true }));
  }

  async doSwitch(id, reason, { manual = false, window = null } = {}) {
    const st = this.state;
    const to = st.accounts[id];
    if (!to) throw new Error('conta não encontrada');
    if (to.needsLogin) throw new Error(`${to.email} precisa entrar de novo; reconecte pelo painel.`);
    await this.reconcile();
    if (st.active === id) return { ok: true, already: true };
    // Renewed first, while parked, so the open sessions do not all race to refresh the same token, and so nothing
    // read from the main item waits in memory while Claude Code runs.
    const parked = await this.kc.read(this.svc(to));
    if (hasRefresh(parked) && expiresAtS(parked) < this.now() + RENEW_BEFORE_S) await this.renewParked(to);
    if (to.needsLogin) throw new Error(`${to.email} precisa entrar de novo; reconecte pelo painel.`);

    const main = await this.kc.read(MAIN_SERVICE);
    const h = tokenHash(main);
    const from = st.active ? st.accounts[st.active] : null;
    if (h && h !== st.mainHash) throw new Error('Ainda não sei qual conta está no Claude Code agora; tente de novo em instantes.');
    if (h && !from) {
      throw new Error(
        `O Claude Code está em ${st.mainEmail ?? 'uma conta'}, que não está no rodízio. Conecte essa conta antes, para o login dela não se perder.`,
      );
    }
    if (from && h) await this.mirror(from, main);
    await this.install(to, { expect: h });

    const t = this.now();
    const textFrom = from ? this.label(from, t) : null;
    st.recentFrom = Object.fromEntries(Object.entries(st.recentFrom).filter(([k, at]) => k !== id && t - at < STALE_WINDOW_S));
    if (from) st.recentFrom[from.id] = t;
    this.setActive(id);
    st.activeSince = t;
    st.lastSwitchAt = t;
    st.pinned = manual;
    st.staleSeen = null;
    if (!manual) st.autoSwitches = [...(st.autoSwitches ?? []).filter((x) => t - x < 3600), t];
    // Followed until the open sessions answer from the new account, or one is seen stuck on the old one.
    st.handover = { from: from?.id ?? null, to: id, at: t, fromReset: from?.usage?.weekly?.resetsAt ?? null, newSeenAt: null, oldSeenAt: null, warned: false };
    this.event(
      'troca',
      from ? `Troquei de ${textFrom} para ${this.label(to, t)}. Motivo: ${reason}.` : `Coloquei ${this.label(to, t)} no Claude Code. Motivo: ${reason}.`,
      { from: from?.id ?? null, to: id, window, manual },
    );
    await this.writeOauthAccountOf(to);
    if (this.config.notify) this.notify('Rodízio de contas', `Agora em ${to.email}${to.plan ? ` (${to.plan.label})` : ''}: ${reason}.`);
    return { ok: true };
  }

  // ------------------------------------------------------------------------------------------------- usage

  /** Status line samples (src/statusline.mjs), one file per session, credited to the account in use. */
  ingestSamples() {
    const st = this.state;
    const now = this.now();
    let files;
    try {
      files = fs.readdirSync(this.p.samples);
    } catch {
      return;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(this.p.samples, f);
      const s = readJson(file);
      if (!s || typeof s.at !== 'number' || !s.sessionId) continue;
      if (now - s.at > SAMPLE_MAX_AGE_S) {
        fs.rmSync(file, { force: true });
        continue;
      }
      const prev = st.sessions[s.sessionId];
      if (prev && prev.at >= s.at) continue;
      st.sessions[s.sessionId] = { at: s.at, sig: s.sig, totals: s.totals ?? null, model: s.model ?? null, ctx: s.ctx ?? null };
      const acc = st.accounts[st.active];
      // Cost, tokens and lines are running totals per session: what grew since the last sample was spent on the
      // account in use. The first sample of a session only sets the starting point.
      const d = acc ? totalsDelta(prev?.totals, s.totals) : null;
      if (d) addActivity(st, acc.id, s.at, d);
      // The status line repeats the session's last numbers on every redraw: only a change is a new reading.
      if (!s.rl || (prev && prev.sig === s.sig)) continue;
      if (!acc || s.at < st.activeSince + SAMPLE_GRACE_S) continue;
      this.followHandover(s);
      if (this.isOtherAccountsWeek(acc, s.rl?.seven_day?.resets_at)) continue;
      this.applyUsage(acc, usageFromStatusline(s.rl), s.at, 'linha de status');
    }
    for (const [id, v] of Object.entries(st.sessions)) if (now - v.at > SAMPLE_MAX_AGE_S) delete st.sessions[id];
  }

  /**
   * After a switch, a fresh answer whose week resets when the previous account's does comes from a session still on
   * that account's token. Seen for a few minutes, it is worth telling: that session will hit the old account's limit.
   */
  followHandover(s) {
    const ho = this.state.handover;
    const reset = s.rl?.seven_day?.resets_at;
    if (!ho || typeof reset !== 'number' || s.at < ho.at + SAMPLE_GRACE_S) return;
    if (ho.fromReset && Math.abs(reset - ho.fromReset) < SAME_RESET_S) {
      ho.oldSeenAt = s.at;
      if (!ho.warned && s.at - ho.at >= HANDOVER_STUCK_S) {
        ho.warned = true;
        const from = this.state.accounts[ho.from];
        this.event('aviso', `Uma sessão aberta ainda responde pela conta anterior${from ? ` (${from.email})` : ''} alguns minutos depois da troca. Se ela travar no limite, feche essa sessão e abra de novo.`);
      }
    } else {
      ho.newSeenAt = s.at;
    }
  }

  /**
   * Each account's week resets at its own time. A sample with another account's reset time comes from a session still
   * on that account's token, however long after the switch.
   */
  isOtherAccountsWeek(acc, reset) {
    if (typeof reset !== 'number') return false;
    const near = (x) => typeof x === 'number' && Math.abs(x - reset) < SAME_RESET_S;
    if (near(acc.usage?.weekly?.resetsAt)) return false;
    return Object.values(this.state.accounts).some((x) => x.id !== acc.id && near(x.usage?.weekly?.resetsAt));
  }

  applyUsage(acc, u, at, source) {
    if (!u.weekly && !u.fiveHour) return;
    if ((acc.usage?.at ?? 0) > at) return;
    acc.usage = {
      weekly: u.weekly ?? acc.usage?.weekly ?? null,
      fiveHour: u.fiveHour ?? acc.usage?.fiveHour ?? null,
      opus: u.opus ?? acc.usage?.opus ?? null,
      sonnet: u.sonnet ?? acc.usage?.sonnet ?? null,
      at,
      source,
    };
    recordHistory(this.state, acc, at);
    // Only a reading that measured the week itself: a week carried over from an older one would move the baseline's
    // time without its value, and the next rise would land in the last few minutes.
    if (u.weekly) consume(this.state, acc.id, capacityOf(acc), { weekly: u.weekly, fiveHour: u.fiveHour ?? null, at });
  }

  async pollUsage({ force = false } = {}) {
    if (!this.config.useApi) return;
    this.wantProof = this.wantProof ?? false;
    // The account in use first: its answer tells whether the endpoint works before judging the parked ones.
    const accounts = Object.values(this.state.accounts).sort((a, b) => (b.id === this.state.active) - (a.id === this.state.active));
    for (const acc of accounts) {
      const now = this.now();
      // A login the API refused is asked again hourly: the refusal may have been the endpoint's, not the login's.
      if (acc.needsLogin && (acc.needsLoginBy !== 'api' || (!force && now - (acc.apiAt ?? 0) < RECHECK_REFUSED_S))) continue;
      const active = acc.id === this.state.active;
      if (!force && !active && !this.config.pollParked) continue;
      const proofWanted = this.wantProof && !active && !(acc.unauthorized > 0);
      if (!force && !proofWanted && !acc.needsLogin && now - (acc.apiAt ?? 0) < this.pollEvery(acc, active, now)) continue;
      if (!force && now < (acc.apiBackoffUntil ?? 0)) continue;
      acc.apiAt = now;
      if (proofWanted) this.wantProof = false;
      try {
        await this.readUsage(acc, active);
      } catch (e) {
        this.warn(`uso:${acc.id}`, e);
      }
    }
  }

  async readUsage(acc, active) {
    const now = this.now();
    let blob = await this.kc.read(active ? MAIN_SERVICE : this.svc(acc));
    if (active && tokenHash(blob) !== acc.lastHash) return; // the main item changed hands; reconcile sorts it out
    if (!hasRefresh(blob)) {
      if (!active) {
        acc.needsLogin = true;
        this.event('erro', `${acc.email} está sem login guardado; reconecte pelo painel.`);
      }
      return;
    }
    if (!active) acc.tokenExpiresAt = expiresAtS(blob);
    // Ahead of time and while it still works, so the token is always ready for a switch; a failed early renewal
    // keeps the current token.
    if (!active && expiresAtS(blob) > now + 60 && expiresAtS(blob) <= now + RENEW_AHEAD_S && now - (acc.renewTriedAt ?? 0) >= RENEW_RETRY_S) {
      blob = (await this.renewParked(acc)) ?? blob;
    }
    if (expiresAtS(blob) <= now + 60) {
      // The sessions renew the account in use themselves; a parked one is renewed through Claude Code, hourly at most.
      if (active || now - (acc.renewTriedAt ?? 0) < RENEW_RETRY_S) {
        acc.apiStatus = 'token_parado';
        return;
      }
      blob = await this.renewParked(acc);
      if (!blob) {
        acc.apiStatus = 'token_parado';
        return;
      }
    }
    const r = await this.api.usage(oauth(blob).accessToken);
    acc.apiStatus = r.status;
    if (r.status === 200) {
      this.apiOkAt[acc.id] = this.now();
      acc.apiFailures = 0;
      acc.apiBackoffUntil = 0;
      acc.unauthorized = 0;
      if (acc.needsLogin && acc.needsLoginBy === 'api') {
        acc.needsLogin = false;
        acc.needsLoginBy = null;
        this.event('conta', `${acc.email} voltou a ser aceita pela Anthropic; está de novo na fila.`);
      }
      acc.usageShape = r.shape ?? null;
      if (!active) acc.plan = planOf(blob) ?? acc.plan;
      this.applyUsage(acc, r, this.now(), 'api');
      return;
    }
    if (r.status === 429) {
      acc.apiBackoffUntil = now + Math.min(MAX_RETRY_AFTER_S, r.retryAfter ?? 15 * 60);
      return;
    }
    if (r.status === 401) {
      // A refused, unexpired token means a revoked login only when it is refused twice, a few minutes apart, while
      // the endpoint keeps answering another account. One bad moment of the endpoint refuses everyone at once and
      // must not flag every account.
      acc.unauthorized = (acc.unauthorized ?? 0) + 1;
      if (acc.unauthorized === 1) {
        acc.unauthorizedSince = now;
        this.wantProof = true; // read another account now: did the endpoint answer anyone since this refusal?
      }
      acc.apiBackoffUntil = now + UNAUTHORIZED_RECHECK_S;
      if (acc.unauthorized >= 2 && this.apiOkElsewhere(acc.id, acc.unauthorizedSince) && !acc.needsLogin) {
        acc.needsLogin = true;
        acc.needsLoginBy = 'api';
        this.event(
          'erro',
          active
            ? `A Anthropic recusou o login de ${acc.email}, que estava com o bastão; passo adiante. Reconecte essa conta pelo painel.`
            : `${acc.email}: a Anthropic recusou o login guardado; reconecte pelo painel.`,
        );
      }
      return;
    }
    // No answer, or a server error: wait longer each time, doubling up to half an hour.
    acc.apiFailures = (acc.apiFailures ?? 0) + 1;
    acc.apiBackoffUntil = now + Math.min(MAX_BACKOFF_S, 60 * 2 ** Math.min(acc.apiFailures - 1, 6));
  }

  refresh() {
    return this.locked(() => this.pollUsage({ force: true }));
  }

  // ---------------------------------------------------------------------------------------------- accounts

  async startLogin({ email = null, reconnectOf = null } = {}) {
    if ([...this.jobs.values()].some((j) => j.running)) throw new Error('Já existe um login em andamento.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('e-mail inválido');
    const target = reconnectOf ? this.state.accounts[reconnectOf] : null;
    if (reconnectOf && !target) throw new Error('conta não encontrada');
    const id = randomBytes(6).toString('hex');
    const job = new LoginJob({
      id,
      dir: path.join(this.p.accounts, id),
      email: email?.toLowerCase() ?? target?.email ?? null,
      reconnectOf,
      cli: this.cli,
      incognito: this.config.incognitoLogin,
      onSuccess: (j) => this.locked(() => this.finishLogin(j)),
      onFail: (j) => this.dropFolder(j.dir),
      onUpdate: () => this.changed(),
    });
    for (const [k, j] of this.jobs) if (!j.running && this.jobs.size >= 5) this.jobs.delete(k);
    // What Claude Code holds now, in case this login lands on it instead of in the account folder (see finishLogin).
    try {
      job.snapshot = { main: await this.kc.read(MAIN_SERVICE), oa: readOauthAccount(this.claudeJson) };
    } catch {
      job.snapshot = null;
    }
    this.jobs.set(id, job);
    job.start();
    return job.view();
  }

  /**
   * Puts the account already logged into Claude Code in the rotation, with no new login: its own item gets a copy of
   * the live token, the same state mirror() keeps for the account in use.
   */
  adoptCurrent() {
    return this.locked(async () => {
      const st = this.state;
      await this.reconcile();
      if (st.active) throw new Error(`${st.accounts[st.active].email} já está no rodízio.`);
      const main = await this.kc.read(MAIN_SERVICE);
      if (!hasRefresh(main)) throw new Error('O Claude Code está sem login neste Mac. Use "Conectar conta".');
      const r = await this.api.profile(oauth(main).accessToken);
      if (r.status !== 200 || !r.uuid) {
        throw new Error('A Anthropic não confirmou de quem é o login do Claude Code agora (sem internet, ou token vencido). Mande uma mensagem no Claude Code e tente de novo.');
      }
      const dup = this.byUuid(r.uuid);
      if (dup) throw new Error(`${dup.email} já está no rodízio.`);
      const id = randomBytes(6).toString('hex');
      const dir = path.join(this.p.accounts, id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const oa = readOauthAccount(this.claudeJson);
      try {
        await this.kc.write(serviceForDir(dir), loginOnly(main));
        await writeOauthAccount(
          path.join(dir, '.claude.json'),
          oa?.accountUuid === r.uuid ? oa : { accountUuid: r.uuid, emailAddress: r.email, organizationUuid: r.orgUuid, organizationName: r.orgName },
        );
      } catch (e) {
        await this.dropFolder(dir).catch(() => {});
        throw e;
      }
      const h = tokenHash(main);
      const acc = {
        id,
        email: r.email ?? oa?.emailAddress ?? '(sem e-mail)',
        uuid: r.uuid,
        orgUuid: r.orgUuid ?? null,
        orgName: r.orgName ?? null,
        plan: planOf(main),
        dir,
        addedAt: this.now(),
        lastHash: h,
        tokenExpiresAt: expiresAtS(main),
        usage: null,
        needsLogin: false,
        paused: false,
      };
      st.accounts[id] = acc;
      this.setActive(id);
      st.activeSince = this.now();
      st.pinned = false;
      this.seen(h);
      this.event('conta', `${acc.email}${acc.plan ? ` (${acc.plan.label})` : ''}, que já estava no Claude Code, entrou no rodízio com o bastão.`);
      if (this.config.useApi) {
        try {
          await this.readUsage(acc, true);
        } catch {
          // the regular poll reads it later
        }
      }
      return acc;
    });
  }

  async finishLogin(job) {
    const st = this.state;
    const svc = serviceForDir(job.dir);
    let blob = await this.kc.read(svc);
    if (!hasRefresh(blob)) blob = await this.recoverMisplacedLogin(job);
    if (!hasRefresh(blob)) throw new Error(`O login terminou, mas a credencial não apareceu no Keychain (${svc}).`);
    const oa = readOauthAccount(path.join(job.dir, '.claude.json'));
    let who = {
      uuid: oa?.accountUuid ?? null,
      email: oa?.emailAddress?.toLowerCase() ?? null,
      orgUuid: oa?.organizationUuid ?? null,
      orgName: oa?.organizationName ?? null,
    };
    if (!who.uuid || !who.email) {
      const r = await this.api.profile(oauth(blob).accessToken);
      if (r.status === 200) {
        who = { uuid: who.uuid ?? r.uuid, email: who.email ?? r.email, orgUuid: who.orgUuid ?? r.orgUuid, orgName: who.orgName ?? r.orgName };
      }
    }
    if (!who.uuid) throw new Error('Não consegui identificar a conta que entrou.');

    if (job.reconnectOf) {
      const acc = st.accounts[job.reconnectOf];
      if (!acc) throw new Error('A conta saiu do rodízio durante o login.');
      if (acc.uuid !== who.uuid) throw new Error(`Você entrou em ${who.email}, mas a conta a reconectar é ${acc.email}.`);
      await this.reconcile();
      await this.kc.write(this.svc(acc), withLogin(await this.kc.read(this.svc(acc)), loginOnly(blob)));
      if (acc.id !== st.active) {
        acc.lastHash = tokenHash(blob);
      } else {
        // The main item gets the new login only while it still holds this account's (a /login elsewhere may have
        // landed since); otherwise the next pass sorts out who is in use.
        const main = await this.kc.read(MAIN_SERVICE);
        if (tokenHash(main) === st.mainHash) {
          const next = withLogin(main, loginOnly(blob));
          await this.kc.write(MAIN_SERVICE, next);
          acc.lastHash = tokenHash(next);
          this.seen(acc.lastHash);
        }
      }
      if (oa) await writeOauthAccount(path.join(acc.dir, '.claude.json'), oa);
      Object.assign(acc, {
        email: who.email ?? acc.email,
        orgName: who.orgName ?? acc.orgName,
        plan: planOf(blob) ?? acc.plan,
        tokenExpiresAt: expiresAtS(blob),
        needsLogin: false,
        needsLoginBy: null,
        unauthorized: 0,
        apiStatus: null,
        apiBackoffUntil: 0,
        renewTriedAt: 0,
      });
      await this.dropFolder(job.dir);
      this.event('conta', `${acc.email} foi reconectada.`);
      return acc;
    }

    const dup = this.byUuid(who.uuid);
    if (dup) throw new Error(`${dup.email} já está no rodízio.`);
    const acc = {
      id: job.id,
      email: who.email ?? '(sem e-mail)',
      uuid: who.uuid,
      orgUuid: who.orgUuid,
      orgName: who.orgName,
      plan: planOf(blob),
      dir: job.dir,
      addedAt: this.now(),
      lastHash: tokenHash(blob),
      tokenExpiresAt: expiresAtS(blob),
      usage: null,
      needsLogin: false,
      paused: false,
    };
    st.accounts[acc.id] = acc;
    // The login already in Claude Code may be this account's: let the next pass look at it again.
    if (!st.active) st.mainHash = null;
    this.event('conta', `${acc.email}${acc.plan ? ` (${acc.plan.label})` : ''} entrou no rodízio.`);
    if (this.config.useApi) {
      try {
        await this.readUsage(acc, false);
      } catch {
        // the regular poll reads it later
      }
    }
    return acc;
  }

  /**
   * A Claude Code that ignored CLAUDE_CONFIG_DIR for the Keychain would have put the new login in the main item, over
   * the account in use. Moves it to the account folder and puts the account in use back from its own item (kept
   * current by mirror). Acts only when the profile proves the main item now holds an account that is neither in the
   * rotation nor the one that was there before.
   */
  async recoverMisplacedLogin(job) {
    const snap = job.snapshot;
    if (!snap) return null;
    const now = await this.kc.read(MAIN_SERVICE);
    const h = tokenHash(now);
    if (!hasRefresh(now) || h === tokenHash(snap.main)) return null;
    if (Object.values(this.state.accounts).some((a) => a.lastHash === h)) return null;
    const r = await this.api.profile(oauth(now).accessToken);
    if (r.status !== 200 || this.byUuid(r.uuid)) return null;
    if (snap.main && r.uuid === snap.oa?.accountUuid) return null; // the account that was there, refreshed
    if (job.email && r.email && r.email !== job.email) return null;

    await this.kc.write(serviceForDir(job.dir), loginOnly(now));
    const folderJson = path.join(job.dir, '.claude.json');
    if (!readOauthAccount(folderJson)) {
      await writeOauthAccount(folderJson, { accountUuid: r.uuid, emailAddress: r.email, organizationUuid: r.orgUuid, organizationName: r.orgName });
    }
    const active = this.state.accounts[this.state.active];
    if (active) {
      await this.install(active, { expect: h });
      await this.writeOauthAccountOf(active);
    } else if (snap.main) {
      await this.kc.write(MAIN_SERVICE, withLogin(now, loginOnly(snap.main)));
      if (snap.oa) await writeOauthAccount(this.claudeJson, snap.oa);
    }
    if (snap.main) this.event('aviso', 'O login novo tinha caído na conta em uso do Claude Code; devolvi a conta anterior e guardei o novo na pasta dele.');
    return this.kc.read(serviceForDir(job.dir));
  }

  async dropFolder(dir) {
    const rel = path.relative(this.p.accounts, dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('pasta fora do rodízio');
    await this.kc.remove(serviceForDir(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  job(id) {
    const j = this.jobs.get(id);
    if (!j) throw new Error('login não encontrado');
    return j;
  }

  removeAccount(id) {
    return this.locked(async () => {
      const acc = this.state.accounts[id];
      if (!acc) throw new Error('conta não encontrada');
      if (id === this.state.active) throw new Error('Essa conta está em uso no Claude Code. Troque para outra antes de remover.');
      await this.dropFolder(acc.dir);
      delete this.state.accounts[id];
      delete this.state.recentFrom[id];
      delete this.state.history[id];
      delete this.state.activity[id];
      forget(this.state, id);
      this.config.order = this.config.order.filter((x) => x !== id);
      this.saveConfig();
      this.event('conta', `${acc.email} saiu do rodízio.`);
    });
  }

  setPaused(id, paused) {
    return this.locked(async () => {
      const acc = this.state.accounts[id];
      if (!acc) throw new Error('conta não encontrada');
      acc.paused = !!paused;
      this.event('conta', `${acc.email} ${acc.paused ? 'ficou fora' : 'voltou para'} a fila de troca.`);
    });
  }

  setOrder(ids) {
    return this.locked(async () => {
      if (!Array.isArray(ids)) throw new Error('ordem inválida');
      const known = ids.filter((id) => this.state.accounts[id]);
      const rest = priority(this.state, this.config).filter((id) => !known.includes(id));
      this.config.order = [...new Set(known), ...rest];
      this.saveConfig();
    });
  }

  setConfig(patch) {
    return this.locked(async () => {
      // An unknown key is refused out loud: silently dropping it is how a page newer than the agent loses settings.
      const unknown = Object.keys(patch ?? {}).filter((k) => !CONFIG_KEYS.includes(k));
      if (unknown.length) throw new Error(`Configuração desconhecida (${unknown.join(', ')}): o agente pode estar desatualizado. Rode \`rodizio doctor --reparar\`.`);
      const next = {};
      for (const k of CONFIG_KEYS) {
        if (!patch || !(k in patch)) continue;
        const v = patch[k];
        if (PCT_KEYS.has(k)) {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 1 || n > 50) throw new Error('A margem precisa ficar entre 1% e 50%.');
          next[k] = Math.round(n * 10) / 10;
        } else {
          if (typeof v !== 'boolean') throw new Error(`${k} precisa ser verdadeiro ou falso`);
          next[k] = v;
        }
      }
      Object.assign(this.config, next);
      this.saveConfig();
    });
  }

  // -------------------------------------------------------------------------------------------- dashboard

  view() {
    const st = this.state;
    const cfg = this.config;
    const now = this.now();
    const trigger = triggerOf(cfg);
    const next = nextCandidate(st, cfg, now);
    const win = (w) => (w ? { pct: effPct(w, now), resetsAt: w.resetsAt && w.resetsAt > now ? w.resetsAt : null } : null);
    const info = insights(st, cfg, now);
    // Color follows the account, never its place in the queue: assigned in the order accounts were connected.
    const slot = Object.fromEntries(
      Object.values(st.accounts)
        .sort((x, y) => (x.addedAt ?? 0) - (y.addedAt ?? 0))
        .map((a, i) => [a.id, i % 8]),
    );
    const accounts = priority(st, cfg).map((id, i) => {
      const a = st.accounts[id];
      const w = weeklyOf(a, now);
      const zone = zoneOf(a, cfg, now);
      let status = 'livre';
      if (a.needsLogin) status = 'precisa_login';
      else if (id === st.active) status = 'ativa';
      else if (a.paused) status = 'pausada';
      else if (zone === 'weekly') status = 'esgotada';
      else if (zone === 'fiveHour') status = 'zona_5h';
      else if (w === null) status = 'sem_leitura';
      return {
        id,
        email: a.email,
        orgName: a.orgName ?? null,
        plan: a.plan?.label ?? null,
        position: i + 1,
        status,
        active: id === st.active,
        next: id === next,
        paused: !!a.paused,
        weekly: win(a.usage?.weekly),
        fiveHour: win(a.usage?.fiveHour),
        usageAt: a.usage?.at ?? null,
        usageSource: a.usage?.source ?? null,
        apiStatus: a.apiStatus ?? null,
        tokenExpiresAt: a.tokenExpiresAt ?? null,
        addedAt: a.addedAt ?? null,
        slot: slot[id],
        zone,
        ...info.perAccount[id],
      };
    });
    const config = {};
    for (const k of CONFIG_KEYS) config[k] = cfg[k];
    const d = this.decision;
    const ho = st.handover;
    const upd = readRecord(this.p.home);
    return {
      api: API_VERSION,
      version: AGENT_VERSION,
      update: { status: upd.status ?? null, latest: upd.latest ?? null, checkedAt: upd.checkedAt ?? null, why: upd.why ?? null, last: upd.last ?? null, running: !!updateInProgress(this.p.home) },
      now,
      port: cfg.port,
      home: displayPath(this.p.home),
      // where this agent runs (the dashboard words logins and logins' windows for it), and the other machines it watches
      platform: process.platform,
      machines: this.machines?.view() ?? [],
      config,
      trigger,
      trigger5: fiveHourTriggerOf(cfg),
      decision: d.kind === 'wait' ? { kind: 'wait', until: d.until } : d.kind === 'throttled' ? { kind: 'throttled', count: d.count } : { kind: d.kind },
      handover:
        ho && now - ho.at < 3600
          ? { to: ho.to, at: ho.at, confirmed: !!ho.newSeenAt, stuck: !!ho.oldSeenAt && ho.oldSeenAt - ho.at >= HANDOVER_STUCK_S && now - ho.oldSeenAt < 600 }
          : null,
      active: st.active,
      activeSince: st.activeSince,
      lastSwitchAt: st.lastSwitchAt,
      mainEmail: st.mainEmail,
      mainPending: !!st.mainPending,
      exhausted: !!st.exhaustedAt,
      pinned: !!st.pinned,
      rotation: info.rotation,
      forecast: info.forecast,
      verdict: info.verdict,
      learning: info.learning,
      today: info.today,
      live: info.live,
      week: info.week,
      timeline: info.timeline,
      accounts,
      events: st.events.slice(0, 80),
      jobs: [...this.jobs.values()].map((j) => j.view()),
    };
  }
}
