// The updater against real git repositories and real SSH signatures, made up in a temporary folder.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CHECK_EVERY_S, applyUpdate, currentVersion, maybeUpdate, newer, parseTag, readRecord, updateInProgress } from '../src/update.mjs';

const ID = { GIT_AUTHOR_NAME: 'Mantenedor', GIT_AUTHOR_EMAIL: 'mantenedor@exemplo.com', GIT_COMMITTER_NAME: 'Mantenedor', GIT_COMMITTER_EMAIL: 'mantenedor@exemplo.com' };

function run(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID, GIT_TERMINAL_PROMPT: '0' } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const git = (cwd, ...args) => run(cwd, 'git', args);

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rodizio-atualizacao-'));
  const key = (name) => {
    run(root, 'ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', path.join(root, `chave-${name}`)]);
    return path.join(root, `chave-${name}.pub`);
  };
  const keys = { mantenedor: key('mantenedor'), estranho: key('estranho'), nova: key('nova') };
  const signer = (pub) => `mantenedor@exemplo.com namespaces="git" ${fs.readFileSync(pub, 'utf8').trim()}`;
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const maint = path.join(root, 'mantenedor');
  git(root, 'init', '-q', '-b', 'main', maint);
  git(maint, 'config', 'gpg.format', 'ssh');
  fs.mkdirSync(path.join(maint, '.github'));
  fs.writeFileSync(path.join(maint, '.github', 'assinaturas_permitidas'), `${signer(keys.mantenedor)}\n`);
  fs.writeFileSync(path.join(maint, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  git(maint, 'add', '-A');
  git(maint, 'commit', '-q', '-m', 'primeira');
  git(maint, '-c', `user.signingkey=${keys.mantenedor}`, 'tag', '-s', 'v1.0.0', '-m', 'primeira versão');
  git(maint, 'remote', 'add', 'origin', origin);
  git(maint, 'push', '-q', 'origin', 'main', '--tags');
  const user = path.join(root, 'usuario');
  git(root, 'clone', '-q', origin, user);

  /** Publishes a version from the maintainer's clone. */
  const release = (version, { key = keys.mantenedor, sign = true, branch = 'main', change } = {}) => {
    if (branch !== 'main') git(maint, 'checkout', '-q', '-B', branch);
    fs.writeFileSync(path.join(maint, 'package.json'), JSON.stringify({ version }));
    change?.(maint);
    git(maint, 'add', '-A');
    git(maint, 'commit', '-q', '-m', `versão ${version}`);
    if (sign) git(maint, '-c', `user.signingkey=${key}`, 'tag', '-s', `v${version}`, '-m', `notas da ${version}`);
    else git(maint, 'tag', '-a', `v${version}`, '-m', `notas da ${version}`);
    git(maint, 'push', '-q', 'origin', branch, '--tags');
    if (branch !== 'main') git(maint, 'checkout', '-q', 'main');
  };
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  return { root, keys, signer, maint, user, home, release };
}

const head = (repo) => git(repo, 'rev-parse', 'HEAD');
const commitOf = (repo, tag) => git(repo, 'rev-parse', `${tag}^{commit}`);

test('versions compare by number', () => {
  assert.ok(newer('v1.10.0', 'v1.9.9'));
  assert.ok(!newer('v1.0.0', '1.0.0'));
  assert.ok(!newer('lixo', '1.0.0'));
});

test('up to date: nothing to do; a signed release on main installs, staying on main', async () => {
  const w = world();
  let r = await maybeUpdate({ home: w.home, repo: w.user, auto: true, force: true });
  assert.equal(r.status, 'em-dia');
  w.release('1.1.0');
  r = await maybeUpdate({ home: w.home, repo: w.user, auto: true, force: true, restart: async () => true });
  assert.equal(r.status, 'atualizado', JSON.stringify(r.record));
  assert.equal(currentVersion(w.user), '1.1.0');
  assert.equal(git(w.user, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(r.record.last.notes, 'notas da 1.1.0');
  // with automatic updates off it only says there is one
  w.release('1.2.0');
  r = await maybeUpdate({ home: w.home, repo: w.user, auto: false, force: true });
  assert.equal(r.status, 'disponivel');
  assert.equal(currentVersion(w.user), '1.1.0');
});

test('unsigned, or signed by a key the installed version does not trust: refused', async () => {
  const w = world();
  const before = head(w.user);
  w.release('1.1.0', { sign: false });
  let r = await applyUpdate('v1.1.0', { repo: w.user });
  assert.equal(r.ok, false);
  assert.match(r.why, /assinatura/);
  w.release('1.2.0', { key: w.keys.estranho });
  r = await applyUpdate('v1.2.0', { repo: w.user });
  assert.match(r.why, /assinatura/);
  assert.equal(head(w.user), before);
});

test('a release that is not on main, or a clone with local changes, is not updated', async () => {
  const w = world();
  w.release('1.1.0', { branch: 'lateral' });
  let r = await applyUpdate('v1.1.0', { repo: w.user });
  assert.match(r.why, /não está no main/);
  w.release('1.2.0');
  fs.writeFileSync(path.join(w.user, 'package.json'), JSON.stringify({ version: '1.0.0', mexido: true }));
  r = await applyUpdate('v1.2.0', { repo: w.user });
  assert.match(r.why, /mudanças locais/);
  git(w.user, 'checkout', '-q', '--', 'package.json');
  git(w.user, 'config', 'rodizio.desenvolvimento', 'true');
  r = await maybeUpdate({ home: w.home, repo: w.user, auto: true, force: true });
  assert.equal(r.status, 'parado');
  assert.match(r.record.why, /desenvolvimento/);
});

test('an agent that does not come back on the new version: the previous one is put back and the release skipped', async () => {
  const w = world();
  const before = head(w.user);
  w.release('1.1.0');
  const t0 = 1_800_000_000;
  let restarts = 0;
  let r = await maybeUpdate({ home: w.home, repo: w.user, auto: true, force: true, now: t0, restart: async () => (restarts++, restarts > 1) });
  assert.equal(r.status, 'falhou');
  assert.equal(head(w.user), before);
  assert.equal(currentVersion(w.user), '1.0.0');
  assert.deepEqual(readRecord(w.home).skip, ['v1.1.0']);
  r = await maybeUpdate({ home: w.home, repo: w.user, auto: true, now: t0 + CHECK_EVERY_S + 1, restart: async () => true });
  assert.equal(r.status, 'pulada');
  // and it waits between looks
  r = await maybeUpdate({ home: w.home, repo: w.user, auto: true, now: t0 + CHECK_EVERY_S + 2 });
  assert.equal(r.status, 'cedo');
});

test('a key changes hands safely: a release signed by the old key trusts the new one', async () => {
  const w = world();
  w.release('1.1.0', { change: (m) => fs.appendFileSync(path.join(m, '.github', 'assinaturas_permitidas'), `${w.signer(w.keys.nova)}\n`) });
  assert.equal((await applyUpdate('v1.1.0', { repo: w.user })).ok, true);
  w.release('1.2.0', { key: w.keys.nova });
  assert.equal((await applyUpdate('v1.2.0', { repo: w.user })).ok, true);
  assert.equal(commitOf(w.user, 'v1.2.0'), head(w.user));
});

test('a signed tag of something else passed off as a version, or one whose package.json disagrees: refused', async () => {
  const w = world();
  // A tag the maintainer signed for a test, published again under a version's name, with main moved onto it.
  fs.writeFileSync(path.join(w.maint, 'teste.txt'), 'só um teste');
  git(w.maint, 'add', '-A');
  git(w.maint, 'commit', '-q', '-m', 'teste');
  git(w.maint, '-c', `user.signingkey=${w.keys.mantenedor}`, 'tag', '-s', 'experimento', '-m', 'só testando');
  git(w.maint, 'update-ref', 'refs/tags/v9.9.9', git(w.maint, 'rev-parse', 'experimento'));
  git(w.maint, 'push', '-q', 'origin', 'main', 'refs/tags/v9.9.9');
  let r = await applyUpdate('v9.9.9', { repo: w.user });
  assert.match(r.why, /feita como experimento/);
  // Signed under the right name, but the code it points at is another version.
  w.release('1.1.0', { change: (m) => fs.writeFileSync(path.join(m, 'package.json'), JSON.stringify({ version: '1.0.5' })) });
  r = await applyUpdate('v1.1.0', { repo: w.user });
  assert.match(r.why, /1\.0\.5 no package\.json/);
  assert.equal(currentVersion(w.user), '1.0.0');
});

test('a rollback that cannot be done is not reported as done: the next run puts the previous version back', async () => {
  const w = world();
  const before = head(w.user);
  w.release('1.1.0');
  const lock = path.join(w.user, '.git', 'index.lock');
  // the new version does not answer, and something holds the clone while it should go back
  let r = await maybeUpdate({ home: w.home, repo: w.user, auto: true, force: true, restart: async () => (fs.writeFileSync(lock, ''), false) });
  assert.equal(r.status, 'falhou');
  assert.match(r.record.why, /não consegui voltar/);
  assert.deepEqual(r.record.skip, []);
  assert.equal(currentVersion(w.user), '1.1.0');
  fs.rmSync(lock);
  const asked = [];
  r = await maybeUpdate({ home: w.home, repo: w.user, auto: true, restart: async (v) => (asked.push(v), true) });
  assert.equal(head(w.user), before);
  assert.deepEqual(asked, ['1.0.0'], 'the agent restarted on the version put back');
  assert.deepEqual(r.record.skip, ['v1.1.0']);
  assert.equal(r.record.rollback, null);
  assert.equal(r.record.last.ok, false);
});

test('one updater at a time; a lock left by one that died does not count', async () => {
  const w = world();
  w.release('1.1.0');
  const lock = path.join(w.home, 'atualizando');
  fs.writeFileSync(lock, String(process.pid)); // another updater, alive
  assert.ok(updateInProgress(w.home));
  let r = await maybeUpdate({ home: w.home, repo: w.user, auto: true, force: true, restart: async () => true });
  assert.equal(r.status, 'ocupado');
  assert.equal(currentVersion(w.user), '1.0.0');
  fs.writeFileSync(lock, '999999');
  assert.equal(updateInProgress(w.home), null);
  const seen = [];
  r = await maybeUpdate({ home: w.home, repo: w.user, auto: true, force: true, restart: async (v) => (seen.push([v, !!updateInProgress(w.home)]), true) });
  assert.equal(r.status, 'atualizado');
  assert.deepEqual(seen, [['1.1.0', true]], 'restarted on the new version, holding the lock');
  assert.ok(!fs.existsSync(lock));
});

test('release notes: the tag message, without a first line that only repeats the version', () => {
  const sig = '-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n';
  assert.deepEqual(parseTag(`object abc\ntype commit\ntag v1.2.0\ntagger M <m@x> 1 +0000\n\nv1.2.0\n\nMais rápido.\n${sig}`), {
    header: { object: 'abc', type: 'commit', tag: 'v1.2.0', tagger: 'M <m@x> 1 +0000' },
    notes: 'Mais rápido.',
  });
  assert.equal(parseTag('object abc\ntype commit\ntag v1.2.0\n\nnotas da 1.2.0').notes, 'notas da 1.2.0');
});
