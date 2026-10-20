// Updates an installation cloned with git to the newest published version. A version is published as a tag vX.Y.Z on
// the main branch, signed with the maintainer's SSH key. Code that updates itself on other people's machines has their
// Claude logins within reach, so every step is a guard:
//
// - only a clone whose tracked files nobody changed is updated (a developer's working copy is left alone);
// - only forward: the new version must contain the current one (never another branch, never an older version);
// - only a tag reachable from origin/main, never any push;
// - only a tag signed by a key listed in the version ALREADY installed (.github/assinaturas_permitidas, read before
//   anything changes): whoever takes over the repository still cannot publish a version that installs;
// - only a tag signed under this very name, on a commit whose package.json says this very version: a signed tag of
//   something else (a test, an old release) cannot be passed off as a new version;
// - the objects are resolved once, and the checks and the switch all use those, whatever the refs do meanwhile; and
//   one updater at a time;
// - after the switch, the new version itself must answer, and still be the same process a while later, or the
//   previous version is put back and the new one skipped.
//
// The only network this needs is git talking to the repository's origin (GitHub). Nothing is sent but git's request.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './util.mjs';

export const REPO = fileURLToPath(new URL('..', import.meta.url));
export const SIGNERS_FILE = path.join('.github', 'assinaturas_permitidas');
export const CHECK_EVERY_S = 6 * 3600;
/** Where a release is fetched to: refs of our own, so nothing else moves them under the checks. */
const CANDIDATE = 'refs/rodizio/candidata';
const MAIN = 'refs/rodizio/main';
/** An updater that holds the lock longer than this died without letting go. */
const LOCK_STALE_S = 30 * 60;

export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}

/** Whether version a is newer than b. */
export function newer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export function currentVersion(repo = REPO) {
  return readJson(path.join(repo, 'package.json'), {})?.version ?? '0.0.0';
}

/**
 * git in the clone, never prompting (an unattended update must fail instead of hanging) and never running hooks.
 * Only talking to the origin uses your git settings (a proxy, say); everything else ignores them, so no filter, hook
 * or signing program of yours runs during an update or changes how a signature is checked.
 */
function git(repo, args, { timeoutMs = 60_000, network = false } = {}) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      ...(network ? {} : { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull }),
    },
  });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() || r.error?.message || '' };
}

/** The newest release tag on origin, by asking it (a light request: only the tag names come back). */
export function latestRemoteTag(repo = REPO) {
  const r = git(repo, ['ls-remote', '--tags', '--refs', 'origin', 'v*'], { network: true });
  if (!r.ok) return { ok: false, error: r.err || 'não consegui falar com o repositório de origem' };
  let best = null;
  for (const line of r.out.split('\n')) {
    const tag = line.split('refs/tags/')[1];
    if (parseVersion(tag) && (!best || newer(tag, best))) best = tag;
  }
  return { ok: true, tag: best };
}

/** Whether this folder can be updated at all, and why not when it cannot. */
export function updatable(repo = REPO) {
  if (!git(repo, ['rev-parse', '--is-inside-work-tree']).ok) return { ok: false, why: 'esta instalação não é um clone do git' };
  // The maintainer's own working copy says so (git config rodizio.desenvolvimento true) and is never moved.
  if (git(repo, ['config', '--get', '--bool', 'rodizio.desenvolvimento']).out === 'true') return { ok: false, why: 'pasta de desenvolvimento: atualizações automáticas desligadas aqui' };
  if (!git(repo, ['remote', 'get-url', 'origin']).ok) return { ok: false, why: 'o clone não tem origem (origin)' };
  const dirty = git(repo, ['status', '--porcelain', '--untracked-files=no']);
  if (!dirty.ok) return { ok: false, why: dirty.err };
  if (dirty.out) return { ok: false, why: 'há mudanças locais no código; atualize à mão' };
  if (!fs.existsSync(path.join(repo, SIGNERS_FILE))) return { ok: false, why: 'esta versão não traz as chaves de assinatura; atualize à mão uma vez' };
  return { ok: true };
}

/** An annotated tag object: its header (what it points at, the name it was made under) and its message. */
export function parseTag(raw) {
  const [head, ...rest] = String(raw).split('\n\n');
  const header = {};
  for (const line of head.split('\n')) {
    const i = line.indexOf(' ');
    if (i > 0) header[line.slice(0, i)] ??= line.slice(i + 1);
  }
  const message = rest.join('\n\n').replace(/-----BEGIN SSH SIGNATURE-----[\s\S]*$/, '').trim();
  // The release notes: the message, without a first line that only repeats the version's name.
  const notes = message.split('\n')[0].trim() === header.tag ? message.split('\n').slice(1).join('\n').trim() : message;
  return { header, notes };
}

/** Puts HEAD back on `previous`; whether that worked. */
function restore(repo, previous, onBranch) {
  const r = onBranch ? git(repo, ['reset', '--quiet', '--keep', previous]) : git(repo, ['checkout', '--quiet', '--detach', previous]);
  const at = git(repo, ['rev-parse', 'HEAD']).out;
  return { ok: r.ok && at === previous, err: r.err || (at !== previous ? `HEAD em ${at.slice(0, 12)}` : '') };
}

/**
 * Checks and, if everything holds, switches to `tag`. `restart(version)` brings the agent back on the code now in the
 * folder and resolves to whether that version answers; on false, the previous version is restored (and restarted)
 * and the result says so.
 */
export async function applyUpdate(tag, { repo = REPO, restart = async () => true, log = () => {} } = {}) {
  const can = updatable(repo);
  if (!can.ok) return { ok: false, why: can.why };
  if (!parseVersion(tag)) return { ok: false, why: `${tag} não é uma versão` };
  const current = currentVersion(repo);
  if (!newer(tag, current)) return { ok: false, why: `${tag} não é mais nova que ${current}` };

  // The keys that may sign the next version are the ones of the version installed now, read before anything moves.
  const trusted = fs.mkdtempSync(path.join(os.tmpdir(), 'rodizio-assinaturas-'));
  const signers = path.join(trusted, 'assinaturas_permitidas');
  fs.copyFileSync(path.join(repo, SIGNERS_FILE), signers);
  try {
    const fetched = git(repo, ['fetch', '--quiet', '--no-tags', '--force', 'origin', `+refs/tags/${tag}:${CANDIDATE}`, `+refs/heads/main:${MAIN}`], { network: true });
    if (!fetched.ok) return { ok: false, why: `não consegui baixar ${tag}: ${fetched.err}` };
    // Resolved once: every check below, and the switch, use these objects.
    const obj = git(repo, ['rev-parse', '--verify', '--quiet', CANDIDATE]).out;
    const main = git(repo, ['rev-parse', '--verify', '--quiet', `${MAIN}^{commit}`]).out;
    if (!obj || !main) return { ok: false, why: `não consegui ler ${tag}` };
    if (git(repo, ['cat-file', '-t', obj]).out !== 'tag') return { ok: false, why: `${tag} não tem assinatura (não é uma tag anotada)` };
    const { header, notes } = parseTag(git(repo, ['cat-file', 'tag', obj]).out);
    if (header.type !== 'commit' || header.tag !== tag || !/^[0-9a-f]{40,64}$/.test(header.object ?? '')) {
      return { ok: false, why: `${tag} aponta para uma tag feita como ${header.tag ?? '?'}, não para esta versão` };
    }
    const commit = header.object;
    const verified = git(repo, ['-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `gpg.ssh.allowedSignersFile=${signers}`, 'verify-tag', obj]);
    if (!verified.ok) return { ok: false, why: `${tag} não tem assinatura válida de uma chave confiável`, detail: verified.err };
    if (!git(repo, ['merge-base', '--is-ancestor', commit, main]).ok) return { ok: false, why: `${tag} não está no main do repositório` };
    if (!git(repo, ['merge-base', '--is-ancestor', 'HEAD', commit]).ok) {
      return { ok: false, why: `${tag} não continua a versão instalada (outro ramo ou mudanças locais commitadas)` };
    }
    const shipped = (() => {
      try {
        return JSON.parse(git(repo, ['show', `${commit}:package.json`]).out).version;
      } catch {
        return null;
      }
    })();
    if (shipped !== tag.slice(1)) return { ok: false, why: `${tag} traz a versão ${shipped ?? '?'} no package.json` };

    const previous = git(repo, ['rev-parse', 'HEAD']).out;
    // On a branch (a plain clone stays on main), the branch moves forward to the release; otherwise HEAD does.
    const onBranch = git(repo, ['symbolic-ref', '-q', '--short', 'HEAD']).ok;
    const moved = onBranch ? git(repo, ['merge', '--quiet', '--ff-only', commit]) : git(repo, ['checkout', '--quiet', '--detach', commit]);
    if (!moved.ok) return { ok: false, why: `não consegui trocar para ${tag}: ${moved.err}` };
    git(repo, ['update-ref', `refs/tags/${tag}`, obj]); // so `git tag` and `git describe` know it
    log(`código em ${tag}; religando o agente`);
    if (await restart(tag.slice(1))) return { ok: true, from: current, to: tag, notes };

    log(`o agente não voltou em ${tag}; voltando para a versão anterior`);
    const back = restore(repo, previous, onBranch);
    if (!back.ok) {
      // Stuck on the new code: the next run tries again (see maybeUpdate).
      return { ok: false, why: `o agente não respondeu depois de ${tag}, e não consegui voltar para ${current}: ${back.err}`, rollback: { to: previous, onBranch, from: current, tag } };
    }
    const up = await restart(current);
    return { ok: false, rolledBack: true, why: `o agente não respondeu depois de ${tag}; voltei para ${current}${up ? '' : ' (que também não respondeu)'}`, skip: tag };
  } finally {
    fs.rmSync(trusted, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------------------------- the lock

const lockPath = (home) => path.join(home, 'atualizando');

/** The pid of the updater running now, if any (a lock left by one that died does not count). */
export function updateInProgress(home, now = Math.floor(Date.now() / 1000)) {
  try {
    const file = lockPath(home);
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (now - fs.statSync(file).mtimeMs / 1000 > LOCK_STALE_S) return null;
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    return e.code === 'EPERM' ? -1 : null;
  }
}

/** One updater at a time (the watchdog, the dashboard's button, `rodizio atualizar`): a release function, or null. */
function takeLock(home) {
  const file = lockPath(home);
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          if (Number(fs.readFileSync(file, 'utf8').trim()) === process.pid) fs.rmSync(file);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (updateInProgress(home)) return null;
      fs.rmSync(file, { force: true }); // left by an updater that died
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------- the record

/** ~/.rodizio/atualizacao.json: when it last looked, what it found, what it did. Read by the dashboard. */
export const recordPath = (home) => path.join(home, 'atualizacao.json');
export const readRecord = (home) => readJson(recordPath(home), {}) ?? {};
export function writeRecord(home, patch) {
  const next = { ...readRecord(home), ...patch };
  writeJsonAtomic(recordPath(home), next);
  return next;
}

/**
 * One look (when due, or forced), and an update when there is one and automatic updates are on. Run by the
 * watchdog every few minutes and by `rodizio atualizar`; it never runs inside the agent, which it restarts.
 */
export async function maybeUpdate({ home, repo = REPO, auto, force = false, apply = auto, restart, log = () => {}, now = Math.floor(Date.now() / 1000) }) {
  const release = takeLock(home);
  if (!release) return { status: 'ocupado', record: readRecord(home) };
  try {
    return await look({ home, repo, auto, force, apply, restart, log, now });
  } finally {
    release();
  }
}

async function look({ home, repo, force, apply, restart, log, now }) {
  const rec = readRecord(home);
  if (rec.rollback) {
    // A previous update could not put the old version back: that comes before anything else.
    const { to, onBranch, from, tag } = rec.rollback;
    const back = restore(repo, to, onBranch);
    if (!back.ok) return { status: 'falhou', record: writeRecord(home, { status: 'falhou', why: `ainda não consegui voltar para ${from}: ${back.err}` }) };
    const up = await restart?.(from);
    log(`voltei para ${from}`);
    return {
      status: 'falhou',
      record: writeRecord(home, {
        checkedAt: now,
        current: currentVersion(repo),
        status: 'falhou',
        why: `o agente não respondeu depois de ${tag}; voltei para ${from}${up ? '' : ' (que também não respondeu)'}`,
        rollback: null,
        skip: [...new Set([...(rec.skip ?? []), tag])],
        last: { at: now, from, to: tag, ok: false, why: `o agente não respondeu em ${tag}`, seen: false },
      }),
    };
  }
  // A clock that went back leaves checkedAt in the future: that counts as due.
  if (!force && rec.checkedAt && rec.checkedAt <= now && now - rec.checkedAt < CHECK_EVERY_S) return { status: 'cedo', record: rec };
  const current = currentVersion(repo);
  const can = updatable(repo);
  if (!can.ok) return { status: 'parado', record: writeRecord(home, { checkedAt: now, current, latest: null, status: 'parado', why: can.why }) };
  const remote = latestRemoteTag(repo);
  if (!remote.ok) return { status: 'erro', record: writeRecord(home, { checkedAt: now, current, status: 'erro', why: remote.error }) };
  const latest = remote.tag;
  const skip = rec.skip ?? [];
  if (!latest || !newer(latest, current)) return { status: 'em-dia', record: writeRecord(home, { checkedAt: now, current, latest, status: 'em-dia', why: null }) };
  if (skip.includes(latest) && !force) return { status: 'pulada', record: writeRecord(home, { checkedAt: now, current, latest, status: 'pulada' }) };
  if (!apply) return { status: 'disponivel', record: writeRecord(home, { checkedAt: now, current, latest, status: 'disponivel', why: null }) };

  log(`versão nova: ${latest} (instalada: ${current})`);
  const r = await applyUpdate(latest, { repo, restart, log });
  if (r.ok) {
    return {
      status: 'atualizado',
      record: writeRecord(home, { checkedAt: now, current: latest.slice(1), latest, status: 'em-dia', why: null, last: { at: now, from: r.from, to: r.to, ok: true, notes: r.notes, seen: false } }),
    };
  }
  return {
    status: 'falhou',
    record: writeRecord(home, {
      checkedAt: now,
      current: currentVersion(repo),
      latest,
      status: 'falhou',
      why: r.why,
      skip: r.skip ? [...new Set([...skip, r.skip])] : skip,
      rollback: r.rollback ?? null,
      last: r.rolledBack ? { at: now, from: current, to: latest, ok: false, why: r.why, seen: false } : rec.last,
    }),
  };
}
