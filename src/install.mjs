// Installs and keeps installed: the agent as a service that starts with the session and comes back when it exits (a
// LaunchAgent on macOS, a systemd user unit on Linux), a watchdog that restarts a hung agent, the status line in
// ~/.claude/settings.json, the `rodizio` command and, on macOS, a Rodízio app to open the dashboard from Spotlight or
// the Dock. `doctor` checks all of it and, with `repair`, puts back what is missing.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findClaude } from './claudecli.mjs';
import { CREDENTIALS_FILE, serviceForDir, systemKeychain } from './keychain.mjs';
import { claudeSettingsPath, paths } from './paths.mjs';
import { ensureConfig, loadState } from './state.mjs';
import { maybeUpdate } from './update.mjs';
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
/** Linux: systemd user units instead of LaunchAgents, and no app (a server has no Dock to put it in). */
const SYSTEMD = process.platform === 'linux';
/** The unit systemd starts and watches, per service: the agent itself; for the watchdog, the timer that runs it. */
const MAIN_UNIT = { [LABEL]: 'rodizio-agente.service', [WATCH_LABEL]: 'rodizio-vigia.timer' };
const UNIT_FILES = { [LABEL]: ['rodizio-agente.service'], [WATCH_LABEL]: ['rodizio-vigia.service', 'rodizio-vigia.timer'] };
const unitDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** systemd's quoting: within "…", backslashes and quotes escaped; % doubled, or systemd reads it as a specifier. */
const sdq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
const sdPath = (s) => String(s).replace(/%/g, '%%');
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

function unitEnv({ pathEnv, home }) {
  return `Environment=${sdq(`PATH=${pathEnv}`)}\nEnvironment=${sdq(`HOME=${home}`)}`;
}

/** Linux: the agent as a systemd user service, started with the user's manager and restarted whenever it exits. */
export function agentUnit({ node, script, logFile, pathEnv, home }) {
  return `[Unit]
Description=rodízio: o agente (revezamento das contas do Claude Code)
After=network-online.target

[Service]
ExecStart=${sdq(node)} ${sdq(script)}
Restart=always
RestartSec=10
# Only the agent itself on a restart: an update or a login it started in a process of its own must outlive it.
KillMode=process
${unitEnv({ pathEnv, home })}
StandardOutput=append:${sdPath(logFile)}
StandardError=append:${sdPath(logFile)}

[Install]
WantedBy=default.target
`;
}

/** Linux: the watchdog as a oneshot service that a timer runs every few minutes (the LaunchAgent's StartInterval). */
export function watchUnits({ node, logFile, pathEnv, home }) {
  return {
    'rodizio-vigia.service': `[Unit]
Description=rodízio: o vigia (religa o agente se ele parar de responder)

[Service]
Type=oneshot
ExecStart=${sdq(node)} ${sdq(path.join(REPO, 'bin', 'rodizio'))} doctor --vigia
${unitEnv({ pathEnv, home })}
StandardOutput=append:${sdPath(logFile)}
StandardError=append:${sdPath(logFile)}
`,
    'rodizio-vigia.timer': `[Unit]
Description=rodízio: o vigia a cada ${WATCH_EVERY_S / 60} minutos

[Timer]
OnActiveSec=60
OnUnitActiveSec=${WATCH_EVERY_S}
AccuracySec=30

[Install]
WantedBy=timers.target
`,
  };
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

/** Each service as the files that define it ({path: content}): a plist on macOS; units on Linux. */
function services(opts) {
  const p = paths();
  const { node, pathEnv } = installEnv(opts);
  const common = { node, pathEnv, home: os.homedir() };
  const agent = { ...common, script: path.join(REPO, 'src', 'main.mjs'), logFile: path.join(p.logs, 'agente.log') };
  const watchdog = { ...common, logFile: path.join(p.logs, 'vigia.log') };
  if (SYSTEMD) {
    const inDir = (units) => Object.fromEntries(Object.entries(units).map(([name, content]) => [path.join(unitDir(), name), content]));
    return { [LABEL]: inDir({ [MAIN_UNIT[LABEL]]: agentUnit(agent) }), [WATCH_LABEL]: inDir(watchUnits(watchdog)) };
  }
  return { [LABEL]: { [plistPath(LABEL)]: plist(agent) }, [WATCH_LABEL]: { [plistPath(WATCH_LABEL)]: watchPlist(watchdog) } };
}

/** Where a service's files are, without computing their content (removing must not depend on node or claude). */
const serviceFiles = (label) => (SYSTEMD ? UNIT_FILES[label].map((n) => path.join(unitDir(), n)) : [plistPath(label)]);

const same = (files) => Object.entries(files).every(([f, c]) => fs.existsSync(f) && fs.readFileSync(f, 'utf8') === c);
const present = (files) => Object.keys(files).some((f) => fs.existsSync(f));

/** systemctl for this user's manager; a process started outside a login session may lack the variable that finds it. */
function systemctl(args, opts = {}) {
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}` };
  return spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', env, ...opts });
}

const isLoaded = (label) =>
  SYSTEMD
    ? systemctl(['is-active', '--quiet', MAIN_UNIT[label]], { stdio: 'ignore' }).status === 0
    : spawnSync('launchctl', ['print', `${domain()}/${label}`], { stdio: 'ignore' }).status === 0;

/** Loads a service from its files (again, if it was loaded: a running one keeps the old definition otherwise). */
function bootstrap(label) {
  if (SYSTEMD) {
    systemctl(['daemon-reload'], { stdio: 'ignore' });
    const r = systemctl(['enable', MAIN_UNIT[label]]);
    if (r.status !== 0) throw new Error(`systemctl enable falhou (${MAIN_UNIT[label]}): ${(r.stderr || r.stdout).trim()}`);
    systemctl(['restart', MAIN_UNIT[label]], { stdio: 'ignore' });
    return;
  }
  spawnSync('launchctl', ['bootout', `${domain()}/${label}`], { stdio: 'ignore' });
  let r;
  for (let i = 0; i < 5; i++) {
    r = spawnSync('launchctl', ['bootstrap', domain(), plistPath(label)], { encoding: 'utf8' });
    if (r.status === 0) return;
    sleep(600); // the bootout of the previous copy may still be finishing
  }
  throw new Error(`launchctl bootstrap falhou (${label}): ${(r.stderr || r.stdout).trim()}`);
}

/** Restarts a loaded service in place. */
function kick(label) {
  if (SYSTEMD) systemctl(['restart', MAIN_UNIT[label]], { stdio: 'ignore' });
  else spawnSync('launchctl', ['kickstart', '-k', `${domain()}/${label}`], { stdio: 'ignore' });
}

/** Stops a service and keeps it from starting again (its files stay until removed). */
function unload(label) {
  if (SYSTEMD) {
    systemctl(['disable', '--now', MAIN_UNIT[label]], { stdio: 'ignore' });
    if (label === WATCH_LABEL) systemctl(['stop', 'rodizio-vigia.service'], { stdio: 'ignore' });
  } else spawnSync('launchctl', ['bootout', `${domain()}/${label}`], { stdio: 'ignore' });
}

/** Writes a service's files when they differ from what they should be, and makes sure it is loaded. */
function ensureService(label, files) {
  if (!same(files)) {
    const existed = present(files);
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    bootstrap(label);
    return existed ? 'atualizado' : 'instalado';
  }
  if (!isLoaded(label)) {
    bootstrap(label);
    return 'religado';
  }
  return null;
}

/** Without lingering, systemd stops a user's services when the last session closes: a server would lose the agent. */
function lingers() {
  const r = spawnSync('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger', '--value'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'yes';
}

const lingerText = (ok) =>
  ok
    ? 'agente segue rodando sem sessão aberta (linger ligado)'
    : `sem "linger", o systemd para o agente quando a última sessão fecha: rode \`sudo loginctl enable-linger ${os.userInfo().username}\``;

/** Down only after a few failed checks some seconds apart: one miss may be the agent starting or a busy moment. */
async function confirmedDown(port, tries = 3, gapMs = 5000) {
  for (let i = 0; i < tries; i++) {
    if (await health(port)) return false;
    if (i < tries - 1) sleep(gapMs);
  }
  return true;
}

export async function health(port, timeoutMs = 3000) {
  return !!(await healthOf(port, timeoutMs));
}

/** What the agent says about itself ({ok, version, pid}), or null when it does not answer. */
async function healthOf(port, timeoutMs = 3000) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.status === 200 ? await r.json() : null;
  } catch {
    return null;
  }
}

async function waitHealthy(port, ms = 10_000) {
  for (let t = 0; t < ms; t += 500) {
    if (await health(port, 1000)) return true;
    sleep(500);
  }
  return false;
}

/**
 * The agent back on the code in this folder: its LaunchAgent rewritten when the code expects another one (that reload
 * restarts it), otherwise restarted in place. Resolves to whether it answers again.
 */
export async function restartAgent({ waitMs = 40_000 } = {}) {
  const config = readJson(paths().config, null);
  if (!config?.port) return false;
  if (!ensureService(LABEL, services()[LABEL])) kick(LABEL);
  return waitHealthy(config.port, waitMs);
}

/**
 * The watchdog's service as this code expects it. Called by the agent when it starts: the watchdog never reloads
 * itself (that would stop it mid-run), so after an update it is the agent that puts the new one in place.
 */
export function syncWatchdog() {
  if (!serviceFiles(WATCH_LABEL).some((f) => fs.existsSync(f))) return null; // not installed: nothing to keep in sync
  return ensureService(WATCH_LABEL, services()[WATCH_LABEL]);
}

/** How long the new version must keep the same process up after it first answers. */
const SETTLE_MS = 30_000;

/**
 * Runs `rodizio reiniciar` with the code now in the folder, in its own process, so a new version restarts itself
 * (and rewrites its LaunchAgent if it needs another). Whether it worked is not taken from that code: the updater
 * itself waits for `version` to answer (on the port in the config, which the new agent may have changed), and for the
 * same process to still answer a while later, so one that starts and then falls over counts as failed.
 */
export async function restartWithNewCode(version, { settleMs = SETTLE_MS } = {}) {
  spawnSync(stableNode(), [path.join(REPO, 'bin', 'rodizio'), 'reiniciar'], { stdio: 'ignore', timeout: 90_000 });
  const answering = async (ms) => {
    for (let t = 0; t < ms; t += 1000) {
      const port = readJson(paths().config, null)?.port;
      const h = port ? await healthOf(port, 1000) : null;
      if (h && (!version || h.version === version)) return h;
      sleep(1000);
    }
    return null;
  };
  const first = await answering(60_000);
  if (!first) return false;
  await new Promise((r) => setTimeout(r, settleMs));
  const again = await answering(5000);
  return !!again && again.pid === first.pid;
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
  if (process.platform !== 'darwin' && !SYSTEMD) throw new Error('o rodízio roda no macOS (Keychain e launchd) e no Linux (systemd)');
  const p = paths();
  for (const d of [p.home, p.accounts, p.samples, p.logs]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const config = await ensureConfig(p);
  const files = services({ refresh: true });
  for (const label of [LABEL, WATCH_LABEL]) {
    for (const [file, content] of Object.entries(files[label])) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    bootstrap(label);
  }
  const [agentFile, watchFile] = [serviceFiles(LABEL)[0], serviceFiles(WATCH_LABEL).at(-1)];
  out(`✓ agente rodando pelo ${SYSTEMD ? 'systemd do usuário' : 'launchd'} (${agentFile})`);
  out(`✓ vigia a cada ${WATCH_EVERY_S / 60} minutos: religa o agente se ele parar de responder (${watchFile})`);
  if (SYSTEMD) {
    const ok = lingers();
    out(`${ok ? '✓' : '!'} ${lingerText(ok)}`);
  }
  out(statusline ? setStatusLine(stableNode()) : '· linha de status não mexida (--sem-linha-de-status)');
  out(linkCli());
  if (SYSTEMD) {
    out(`\nPainel: ${dashboardUrl(config)}  (aqui não há navegador: no Mac, adicione esta máquina em "Outras máquinas", no painel de lá; ou rode \`rodizio painel --url\` e abra por um túnel SSH)`);
    return;
  }
  out(createApp());
  out(`\nPainel: ${dashboardUrl(config)}  (rode \`rodizio painel\` ou abra o app Rodízio: ele já leva a chave de acesso)`);
}

export async function uninstall({ purge = false, out = console.log } = {}) {
  for (const label of [WATCH_LABEL, LABEL]) {
    unload(label);
    for (const file of serviceFiles(label)) fs.rmSync(file, { force: true });
  }
  if (SYSTEMD) systemctl(['daemon-reload'], { stdio: 'ignore' });
  out(`✓ agente e vigia parados e removidos do ${SYSTEMD ? 'systemd' : 'launchd'}`);
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
  const kc = systemKeychain({ accountsDir: p.accounts });
  for (const acc of Object.values(loadState(p).accounts)) {
    await kc.remove(serviceForDir(acc.dir));
    out(`✓ login de ${acc.email} apagado ${SYSTEMD ? `(${CREDENTIALS_FILE} da pasta da conta)` : 'do Keychain'}`);
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
  const files = services({ refresh: repair && !watch });
  // The watchdog only keeps the agent loaded: it never rewrites a service (that is `doctor --reparar` or `instalar`,
  // run by you) and never reloads its own, which would stop it mid-run.
  const manager = SYSTEMD ? 'systemd' : 'launchd';
  const list = watch ? [[LABEL, `agente no ${manager}`]] : [[LABEL, `agente no ${manager}`], [WATCH_LABEL, `vigia no ${manager}`]];
  for (const [label, name] of list) {
    const there = present(files[label]);
    const loaded = isLoaded(label);
    if (watch) {
      if (!there) note(true, `${name}: ${ensureService(label, files[label])}`);
      else if (!loaded) {
        bootstrap(label);
        note(true, `${name}: religado`);
      } else note(true, name);
      continue;
    }
    const current = same(files[label]);
    if (current && loaded) note(true, name);
    else if (repair) note(true, `${name}: ${ensureService(label, files[label]) ?? 'ok'}`);
    else note(false, `${name}: ${!there ? 'não instalado' : !current ? 'desatualizado' : 'parado'}`);
  }
  if (SYSTEMD && !watch) note(lingers(), lingerText(lingers()));
  let alive = repair ? !(await confirmedDown(config.port)) : await health(config.port);
  if (!alive && repair) {
    kick(LABEL);
    alive = await waitHealthy(config.port);
    note(alive, alive ? `painel em 127.0.0.1:${config.port}: não respondia, religado` : `painel em 127.0.0.1:${config.port}: não volta; veja ${path.join(p.logs, 'agente.log')}`);
  } else {
    note(alive, alive ? `painel respondendo em ${dashboardUrl(config)}` : `painel em 127.0.0.1:${config.port}: não responde`);
  }
  if (watch) {
    // A new published version, when it is time to look and automatic updates are on (see update.mjs for the guards).
    // Also with the agent down: the version that fixes it has to be able to arrive.
    const r = await maybeUpdate({ home: p.home, auto: config.autoUpdate !== false, restart: restartWithNewCode, log: (m) => note(true, `atualização: ${m}`) });
    if (r.status === 'atualizado') note(true, `atualização: agora em ${r.record.current}`);
    else if (r.status === 'falhou') note(false, `atualização: ${r.record.why}`);
    else if (r.status === 'disponivel') note(true, `atualização: ${r.record.latest} disponível (automática desligada)`);
    else if (r.status === 'ocupado') note(true, 'atualização: outra já está em andamento');
  }
  if (!watch) {
    if (statusLineOk()) note(true, 'linha de status do Claude Code');
    else if (repair) note(true, setStatusLine(stableNode()).replace(/^[✓!] /, 'linha de status: '));
    else note(false, 'linha de status do Claude Code: não configurada');
    if (cliOk()) note(true, 'comando rodizio');
    else if (repair) note(true, linkCli().replace(/^[✓!] /, ''));
    else note(false, 'comando rodizio: não está em ~/.local/bin');
    if (SYSTEMD) {
      // no app on Linux: the dashboard is opened from another computer (Outras máquinas) or through a tunnel
    } else if (appOk()) note(true, `app Rodízio em ${appPath()}`);
    else if (repair) note(true, createApp().replace(/^[✓!] /, ''));
    else note(false, 'app Rodízio: não criado');
  }
  return report(lines, out, watch);
}

function report(lines, out, watch) {
  const stamp = new Date().toISOString();
  for (const l of lines) {
    // The watchdog writes only repairs and problems, so its log stays short.
    if (watch && l.good && !/religado|instalado|atualizado|atualização/.test(l.text)) continue;
    out(`${watch ? `${stamp} ` : ''}${l.good ? '✓' : '✗'} ${l.text}`);
  }
  const bad = lines.filter((l) => !l.good).length;
  if (!watch) out(bad ? `\n${bad} problema(s). Rode \`rodizio doctor --reparar\` para consertar.` : '\nTudo certo.');
  return { ok: bad === 0, lines };
}
