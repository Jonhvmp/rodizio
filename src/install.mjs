// Installs and keeps installed: the agent as a LaunchAgent, a watchdog LaunchAgent that restarts a hung agent, the
// status line in ~/.claude/settings.json, the `rodizio` command and a Rodízio app to open the dashboard from Spotlight
// or the Dock. `doctor` checks all of it and, with `repair`, puts back what is missing.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findClaude } from './claudecli.mjs';
import { MacKeychain, serviceForDir } from './keychain.mjs';
import { claudeSettingsPath, paths } from './paths.mjs';
import { ensureConfig, loadState } from './state.mjs';
import { readJson, writeJsonAtomic } from './util.mjs';

export const LABEL = 'local.rodizio.agente';
export const WATCH_LABEL = 'local.rodizio.vigia';
export const WATCH_EVERY_S = 300;
const REPO = fileURLToPath(new URL('..', import.meta.url));
const launchAgents = () => path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = (label = LABEL) => path.join(launchAgents(), `${label}.plist`);
const cliLink = () => path.join(os.homedir(), '.local', 'bin', 'rodizio');
export const appPath = () => path.join(os.homedir(), 'Applications', 'Rodízio.app');
const domain = () => `gui/${process.getuid()}`;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The address the dashboard is opened at: browsers resolve any *.localhost name to this machine. */
export const dashboardUrl = (config) => `http://rodizio.localhost:${config.port}/`;

/** Homebrew's link survives `brew upgrade node`; the Cellar path this process runs from does not. */
export function stableNode() {
  for (const c of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try {
      if (fs.realpathSync(c) === fs.realpathSync(process.execPath)) return c;
    } catch {
      // not there
    }
  }
  return process.execPath;
}

function plistXml({ label, args, logFile, pathEnv, home, keepAlive, every }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
${keepAlive ? '  <key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>10</integer>\n' : ''}${every ? `  <key>StartInterval</key><integer>${every}</integer>\n` : ''}  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(pathEnv)}</string>
    <key>HOME</key><string>${xml(home)}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

/** The agent: started at login, restarted whenever it exits. */
export function plist({ node, script, logFile, pathEnv, home }) {
  return plistXml({ label: LABEL, args: [node, script], logFile, pathEnv, home, keepAlive: true });
}

/** The watchdog: every few minutes, checks that the agent answers and restarts it when it does not. */
export function watchPlist({ node, logFile, pathEnv, home }) {
  return plistXml({ label: WATCH_LABEL, args: [node, path.join(REPO, 'bin', 'rodizio'), 'doctor', '--vigia'], logFile, pathEnv, home, every: WATCH_EVERY_S });
}

const installFile = () => path.join(paths().home, 'instalacao.json');

/**
 * The node, claude and PATH the services run with, fixed when installing. Computing them again on every call would
 * make the expected LaunchAgents depend on whoever calls (the Rodízio app runs with a bare PATH).
 */
function installEnv({ refresh = false } = {}) {
  const saved = readJson(installFile(), null);
  if (saved?.node && saved?.pathEnv && !refresh && fs.existsSync(saved.node)) return saved;
  const node = stableNode();
  const claude = findClaude();
  const env = {
    node,
    claude,
    pathEnv: [...new Set([path.dirname(claude), path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':'),
  };
  writeJsonAtomic(installFile(), env);
  return env;
}

function plists(opts) {
  const p = paths();
  const { node, pathEnv } = installEnv(opts);
  const common = { node, pathEnv, home: os.homedir() };
  return {
    [LABEL]: plist({ ...common, script: path.join(REPO, 'src', 'main.mjs'), logFile: path.join(p.logs, 'agente.log') }),
    [WATCH_LABEL]: watchPlist({ ...common, logFile: path.join(p.logs, 'vigia.log') }),
  };
}

const isLoaded = (label) => spawnSync('launchctl', ['print', `${domain()}/${label}`], { stdio: 'ignore' }).status === 0;

function bootstrap(label) {
  spawnSync('launchctl', ['bootout', `${domain()}/${label}`], { stdio: 'ignore' });
  let r;
  for (let i = 0; i < 5; i++) {
    r = spawnSync('launchctl', ['bootstrap', domain(), plistPath(label)], { encoding: 'utf8' });
    if (r.status === 0) return;
    sleep(600); // the bootout of the previous copy may still be finishing
  }
  throw new Error(`launchctl bootstrap falhou (${label}): ${(r.stderr || r.stdout).trim()}`);
}

/** Writes a LaunchAgent when it differs from what it should be, and makes sure it is loaded. */
function ensureService(label, content) {
  const file = plistPath(label);
  fs.mkdirSync(launchAgents(), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (current !== content) {
    fs.writeFileSync(file, content);
    bootstrap(label);
    return current === null ? 'instalado' : 'atualizado';
  }
  if (!isLoaded(label)) {
    bootstrap(label);
    return 'religado';
  }
  return null;
}

/** Down only after a few failed checks some seconds apart: one miss may be the agent starting or a busy moment. */
async function confirmedDown(port, tries = 3, gapMs = 5000) {
  for (let i = 0; i < tries; i++) {
    if (await health(port)) return false;
    if (i < tries - 1) sleep(gapMs);
  }
  return true;
}

export async function health(port, timeoutMs = 3000) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.status === 200;
  } catch {
    return false;
  }
}

async function waitHealthy(port, ms = 10_000) {
  for (let t = 0; t < ms; t += 500) {
    if (await health(port, 1000)) return true;
    sleep(500);
  }
  return false;
}

// -------------------------------------------------------------------------------------------- status line

const isOurs = (statusLine) => typeof statusLine?.command === 'string' && statusLine.command.includes(path.join(REPO, 'src', 'statusline.mjs'));

export function setStatusLine(node, file = claudeSettingsPath()) {
  const exists = fs.existsSync(file);
  const settings = exists ? readJson(file, null) : {};
  if (settings === null) return `! ${file} não é JSON válido: linha de status não configurada`;
  const current = settings.statusLine;
  if (current && !isOurs(current)) {
    return `! já existe outra linha de status em ${file}; não troquei. Sem a do rodízio, o uso da conta em uso vem só da API.`;
  }
  const wanted = { type: 'command', command: `${shq(node)} ${shq(path.join(REPO, 'src', 'statusline.mjs'))}`, padding: 0 };
  if (JSON.stringify(current) === JSON.stringify(wanted)) return '✓ linha de status já estava configurada';
  if (exists) fs.copyFileSync(file, `${file}.rodizio.bak`);
  settings.statusLine = wanted;
  writeJsonAtomic(file, settings, exists ? fs.statSync(file).mode & 0o777 : 0o644);
  return `✓ linha de status configurada em ${file}${exists ? ' (cópia anterior em settings.json.rodizio.bak)' : ''}`;
}

export function removeStatusLine(file = claudeSettingsPath()) {
  const settings = readJson(file, null);
  if (!settings || !isOurs(settings.statusLine)) return null;
  delete settings.statusLine;
  writeJsonAtomic(file, settings, fs.statSync(file).mode & 0o777);
  return '✓ linha de status removida';
}

const statusLineOk = (file = claudeSettingsPath()) => isOurs(readJson(file, {})?.statusLine);

// ------------------------------------------------------------------------------------------- the command

function linkCli() {
  const link = cliLink();
  const target = path.join(REPO, 'bin', 'rodizio');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    const current = fs.readlinkSync(link);
    if (current === target) return `✓ comando rodizio em ${link}`;
    return `! ${link} já aponta para ${current}; não troquei`;
  } catch (e) {
    if (e.code === 'EINVAL') return `! ${link} já existe e não é um link; não troquei`;
  }
  fs.symlinkSync(target, link);
  return `✓ comando rodizio em ${link}`;
}

const cliOk = () => {
  try {
    return fs.readlinkSync(cliLink()) === path.join(REPO, 'bin', 'rodizio');
  } catch {
    return false;
  }
};

// ----------------------------------------------------------------------------------------------- the app

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="230" fill="#0b0b0b"/><rect x="224" y="432" width="576" height="160" rx="80" fill="#fcfcfb" transform="rotate(-30 512 512)"/><circle cx="752" cy="376" r="46" fill="#eb6834"/></svg>`;

/** Best effort: a Finder icon drawn from ICON_SVG. The app works without it. */
function appIcon(app) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rodizio-icon-'));
  try {
    const svg = path.join(tmp, 'icon.svg');
    fs.writeFileSync(svg, ICON_SVG);
    if (spawnSync('qlmanage', ['-t', '-s', '1024', '-o', tmp, svg], { stdio: 'ignore' }).status !== 0) return false;
    const png = path.join(tmp, 'icon.svg.png');
    if (!fs.existsSync(png)) return false;
    const set = path.join(tmp, 'icon.iconset');
    fs.mkdirSync(set);
    for (const s of [16, 32, 128, 256, 512]) {
      spawnSync('sips', ['-z', String(s), String(s), png, '--out', path.join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
      spawnSync('sips', ['-z', String(s * 2), String(s * 2), png, '--out', path.join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
    }
    const icns = path.join(tmp, 'icon.icns');
    if (spawnSync('iconutil', ['-c', 'icns', set, '-o', icns], { stdio: 'ignore' }).status !== 0) return false;
    fs.copyFileSync(icns, path.join(app, 'Contents', 'Resources', 'applet.icns'));
    spawnSync('touch', [app]);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** ~/Applications/Rodízio.app: opens the dashboard (fixing the agent first if needed), findable from Spotlight. */
export function createApp() {
  const app = appPath();
  const command = `${shq(stableNode())} ${shq(path.join(REPO, 'bin', 'rodizio'))} painel`;
  fs.mkdirSync(path.dirname(app), { recursive: true });
  fs.rmSync(app, { recursive: true, force: true });
  const script = `do shell script "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const r = spawnSync('osacompile', ['-o', app, '-e', script], { encoding: 'utf8' });
  if (r.status !== 0) return `! não consegui criar ${app}: ${(r.stderr || '').trim()}`;
  const icon = appIcon(app);
  return `✓ app Rodízio em ${app}${icon ? '' : ' (sem ícone próprio)'}: abra pelo Spotlight (⌘ espaço, "Rodízio") ou arraste para o Dock`;
}

const appOk = () => fs.existsSync(path.join(appPath(), 'Contents', 'MacOS'));

// ------------------------------------------------------------------------------------- install / remove

export async function install({ statusline = true, out = console.log } = {}) {
  if (process.platform !== 'darwin') throw new Error('o rodízio foi feito para macOS (Keychain e launchd)');
  const p = paths();
  for (const d of [p.home, p.accounts, p.samples, p.logs]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const config = await ensureConfig(p);
  const files = plists({ refresh: true });
  for (const label of [LABEL, WATCH_LABEL]) {
    fs.mkdirSync(launchAgents(), { recursive: true });
    fs.writeFileSync(plistPath(label), files[label]);
    bootstrap(label);
  }
  out(`✓ agente rodando pelo launchd (${plistPath()})`);
  out(`✓ vigia a cada ${WATCH_EVERY_S / 60} minutos: religa o agente se ele parar de responder (${plistPath(WATCH_LABEL)})`);
  out(statusline ? setStatusLine(stableNode()) : '· linha de status não mexida (--sem-linha-de-status)');
  out(linkCli());
  out(createApp());
  out(`\nPainel: ${dashboardUrl(config)}  (rode \`rodizio painel\` ou abra o app Rodízio: ele já leva a chave de acesso)`);
}

export async function uninstall({ purge = false, out = console.log } = {}) {
  for (const label of [WATCH_LABEL, LABEL]) {
    spawnSync('launchctl', ['bootout', `${domain()}/${label}`], { stdio: 'ignore' });
    fs.rmSync(plistPath(label), { force: true });
  }
  out('✓ agente e vigia parados e removidos do launchd');
  const sl = removeStatusLine();
  if (sl) out(sl);
  if (cliOk()) {
    fs.rmSync(cliLink());
    out('✓ comando rodizio removido');
  }
  if (fs.existsSync(appPath())) {
    fs.rmSync(appPath(), { recursive: true, force: true });
    out('✓ app Rodízio removido');
  }
  const p = paths();
  if (!purge) {
    out(`· logins guardados e ${p.home} ficaram (use --apagar-tudo para tirar também)`);
    return;
  }
  const kc = new MacKeychain();
  for (const acc of Object.values(loadState(p).accounts)) {
    await kc.remove(serviceForDir(acc.dir));
    out(`✓ login de ${acc.email} apagado do Keychain`);
  }
  fs.rmSync(p.home, { recursive: true, force: true });
  out(`✓ ${p.home} apagado. O login que está no Claude Code agora continua lá.`);
}

// ---------------------------------------------------------------------------------------------- doctor

/**
 * Checks everything the rotation needs. `repair` puts back what is missing; `watch` is the watchdog's mode: it only
 * keeps the agent alive (never touches the status line, the command or the app, which you may have removed on
 * purpose) and prints only what it did.
 */
export async function doctor({ repair = false, watch = false, out = console.log } = {}) {
  const p = paths();
  const lines = [];
  const note = (good, text) => lines.push({ good, text });
  let config = readJson(p.config, null);
  if (!config?.port) {
    if (!repair) {
      note(false, 'o rodízio não está instalado: rode `rodizio instalar`');
      return report(lines, out, watch);
    }
    config = await ensureConfig(p);
  }
  const files = plists({ refresh: repair && !watch });
  // The watchdog only keeps the agent loaded: it never rewrites a LaunchAgent (that is `doctor --reparar` or
  // `instalar`, run by you) and never reloads its own, which would stop it mid-run.
  const services = watch ? [[LABEL, 'agente no launchd']] : [[LABEL, 'agente no launchd'], [WATCH_LABEL, 'vigia no launchd']];
  for (const [label, name] of services) {
    const current = fs.existsSync(plistPath(label)) ? fs.readFileSync(plistPath(label), 'utf8') : null;
    const loaded = isLoaded(label);
    if (watch) {
      if (current === null) note(true, `${name}: ${ensureService(label, files[label])}`);
      else if (!loaded) {
        bootstrap(label);
        note(true, `${name}: religado`);
      } else note(true, name);
      continue;
    }
    const fine = current === files[label] && loaded;
    if (fine) note(true, name);
    else if (repair) note(true, `${name}: ${ensureService(label, files[label]) ?? 'ok'}`);
    else note(false, `${name}: ${current === null ? 'não instalado' : current !== files[label] ? 'desatualizado' : 'parado'}`);
  }
  let alive = repair ? !(await confirmedDown(config.port)) : await health(config.port);
  if (!alive && repair) {
    spawnSync('launchctl', ['kickstart', '-k', `${domain()}/${LABEL}`], { stdio: 'ignore' });
    alive = await waitHealthy(config.port);
    note(alive, alive ? `painel em 127.0.0.1:${config.port}: não respondia, religado` : `painel em 127.0.0.1:${config.port}: não volta; veja ${path.join(p.logs, 'agente.log')}`);
  } else {
    note(alive, alive ? `painel respondendo em ${dashboardUrl(config)}` : `painel em 127.0.0.1:${config.port}: não responde`);
  }
  if (!watch) {
    if (statusLineOk()) note(true, 'linha de status do Claude Code');
    else if (repair) note(true, setStatusLine(stableNode()).replace(/^[✓!] /, 'linha de status: '));
    else note(false, 'linha de status do Claude Code: não configurada');
    if (cliOk()) note(true, 'comando rodizio');
    else if (repair) note(true, linkCli().replace(/^[✓!] /, ''));
    else note(false, 'comando rodizio: não está em ~/.local/bin');
    if (appOk()) note(true, `app Rodízio em ${appPath()}`);
    else if (repair) note(true, createApp().replace(/^[✓!] /, ''));
    else note(false, 'app Rodízio: não criado');
  }
  return report(lines, out, watch);
}

function report(lines, out, watch) {
  const stamp = new Date().toISOString();
  for (const l of lines) {
    // The watchdog writes only repairs and problems, so its log stays short.
    if (watch && l.good && !/religado|instalado|atualizado/.test(l.text)) continue;
    out(`${watch ? `${stamp} ` : ''}${l.good ? '✓' : '✗'} ${l.text}`);
  }
  const bad = lines.filter((l) => !l.good).length;
  if (!watch) out(bad ? `\n${bad} problema(s). Rode \`rodizio doctor --reparar\` para consertar.` : '\nTudo certo.');
  return { ok: bad === 0, lines };
}
