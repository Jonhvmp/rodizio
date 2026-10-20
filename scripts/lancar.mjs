#!/usr/bin/env node
// Publishes a version: the tests, the version in package.json, a commit, a signed annotated tag carrying the notes,
// and the push. Installations pick it up on their own (src/update.mjs), and only because the tag is signed by a key
// listed in .github/assinaturas_permitidas.
//
//   node scripts/lancar.mjs 0.6.0 "O que mudou nesta versão"
//
// Needs, once, in this clone: git config gpg.format ssh; git config user.signingkey ~/.ssh/<key>.pub (that key listed
// in .github/assinaturas_permitidas).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGNERS_FILE, currentVersion, newer, parseVersion } from '../src/update.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

function run(cmd, args, { show = false } = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: show ? 'inherit' : 'pipe' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} falhou${r.stderr ? `: ${r.stderr.trim()}` : ''}`);
  return (r.stdout ?? '').trim();
}
const git = (...args) => run('git', args);

function main([version, ...notesParts]) {
  const notes = notesParts.join(' ').trim();
  if (!parseVersion(version) || !notes) throw new Error('uso: node scripts/lancar.mjs <versão, ex. 0.6.0> "<notas da versão>"');
  const tag = `v${version.replace(/^v/, '')}`;
  const current = currentVersion(REPO);
  if (!newer(tag, current)) throw new Error(`${tag} precisa ser mais nova que ${current}`);
  if (git('symbolic-ref', '--short', 'HEAD') !== 'main') throw new Error('publique a partir do main');
  if (git('status', '--porcelain')) throw new Error('há mudanças não commitadas');
  git('fetch', '--quiet', 'origin', 'main');
  if (git('rev-list', '--count', 'HEAD..origin/main') !== '0') throw new Error('o main local está atrás do origin/main');

  // The key that will sign must be one the installations trust, or nobody would accept this version.
  if (git('config', '--get', 'gpg.format') !== 'ssh') throw new Error('configure: git config gpg.format ssh');
  const keyPath = git('config', '--get', 'user.signingkey').replace(/^~(?=\/)/, os.homedir());
  const key = fs.readFileSync(keyPath, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  if (!fs.readFileSync(path.join(REPO, SIGNERS_FILE), 'utf8').includes(key)) throw new Error(`a chave ${keyPath} não está em ${SIGNERS_FILE}`);

  console.log('testes…');
  run('npm', ['test', '--silent'], { show: true });

  const pkgFile = path.join(REPO, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.version = tag.slice(1);
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  git('commit', '--quiet', '-am', `${tag}\n\n${notes}`);
  git('tag', '-s', tag, '-m', `${tag}\n\n${notes}`);
  run('git', ['-c', `gpg.ssh.allowedSignersFile=${path.join(REPO, SIGNERS_FILE)}`, 'verify-tag', tag]);
  git('push', '--quiet', 'origin', 'main', tag);
  console.log(`publicada ${tag}. As instalações com atualização automática a recebem em até 6 horas.`);
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error(`lancar: ${e.message}`);
  process.exitCode = 1;
}
