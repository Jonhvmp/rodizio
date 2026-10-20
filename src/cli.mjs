import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { paths } from './paths.mjs';
import { readJson } from './util.mjs';

const HELP = `rodizio: rodízio local das contas do Claude Code

  rodizio painel               abre o painel no navegador (e religa o agente antes, se precisar)
  rodizio status               contas, uso e a conta em uso
  rodizio trocar <e-mail>      troca agora para essa conta
  rodizio doctor [--reparar]   confere agente, vigia, painel, linha de status, comando e app
  rodizio instalar             agente e vigia no launchd, linha de status, o comando e o app Rodízio
      --sem-linha-de-status    não mexe em ~/.claude/settings.json
  rodizio desinstalar          tira agente, vigia, linha de status, comando e app
      --apagar-tudo            também apaga os logins guardados e ~/.rodizio
  rodizio agente [--demo]      roda o agente neste terminal (--demo: contas de exemplo)
`;

function config() {
  const c = readJson(paths().config, null);
  if (!c?.port) throw new Error('o rodízio ainda não foi instalado: rode `rodizio instalar`');
  return c;
}

async function call(method, route, body) {
  const c = config();
  const r = await fetch(`http://127.0.0.1:${c.port}${route}`, {
    method,
    headers: { 'X-Rodizio-Token': c.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro ?? `erro ${r.status}`);
  return j;
}

const pct = (w) => (w?.pct === null || w?.pct === undefined ? '  —' : `${Math.round(w.pct)}%`.padStart(4));
const day = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

async function status() {
  const c = config();
  let s;
  try {
    s = await call('GET', '/api/state');
  } catch {
    console.log(`O agente não está respondendo em 127.0.0.1:${c.port}. Rode \`rodizio instalar\` ou veja ${path.join(paths().logs, 'agente.log')}.`);
    return;
  }
  const five = s.config.fiveHourSwitch ? ` ou de ${s.trigger5}% da janela de 5 h` : '';
  console.log(`Rodízio · http://rodizio.localhost:${s.port}/ · troca ao passar de ${s.trigger}% da semana${five}${s.config.auto ? '' : ' (automática DESLIGADA)'}`);
  if (!s.accounts.length) console.log('Nenhuma conta conectada ainda: rode `rodizio painel` e conecte.');
  for (const a of s.accounts) {
    const reset = a.weekly?.resetsAt ? `renova ${day.format(new Date(a.weekly.resetsAt * 1000))}` : '';
    const note = a.status === 'precisa_login' ? '  ! reconectar' : a.paused ? '  (fora da fila)' : '';
    console.log(`${a.active ? '▶' : ' '} ${a.position}  ${a.email.padEnd(32)} ${(a.plan ?? '').padEnd(8)} semana ${pct(a.weekly)}  5h ${pct(a.fiveHour)}  ${reset}${note}`);
  }
  if (!s.active) console.log(`\nO Claude Code está em ${s.mainEmail ?? 'nenhuma conta'}, fora do rodízio.`);
}

export async function main(args) {
  const [cmd = 'ajuda', ...rest] = args;
  try {
    switch (cmd) {
      case 'painel': {
        const { dashboardUrl, doctor, health } = await import('./install.mjs');
        let c = config();
        if (!(await health(c.port))) {
          // the agent is down or hung: put it back before opening a page that would not load
          await doctor({ repair: true, watch: true, out: (s) => console.log(s) });
          c = config();
        }
        spawnSync('open', [`${dashboardUrl(c)}#t=${c.token}`]);
        return;
      }
      case 'doctor': {
        // --vigia is the watchdog: it always repairs, but only what keeps the agent alive
        const watch = rest.includes('--vigia');
        return await (await import('./install.mjs')).doctor({ repair: watch || rest.includes('--reparar'), watch });
      }
      case 'status':
        return await status();
      case 'trocar': {
        const email = (rest[0] ?? '').toLowerCase();
        if (!email) throw new Error('uso: rodizio trocar <e-mail>');
        const s = await call('GET', '/api/state');
        const a = s.accounts.find((x) => x.email === email);
        if (!a) throw new Error(`${email} não está no rodízio`);
        await call('POST', `/api/accounts/${a.id}/use`);
        console.log(`Agora em ${a.email}.`);
        return;
      }
      case 'instalar':
        return await (await import('./install.mjs')).install({ statusline: !rest.includes('--sem-linha-de-status') });
      case 'desinstalar':
        return await (await import('./install.mjs')).uninstall({ purge: rest.includes('--apagar-tudo') });
      case 'agente':
        if (rest.includes('--demo')) {
          process.env.RODIZIO_DEMO = '1';
          process.env.RODIZIO_HOME ??= path.join(os.homedir(), '.rodizio-demo');
        }
        await (await import('./main.mjs')).startAgent();
        return;
      default:
        process.stdout.write(HELP);
    }
  } catch (e) {
    console.error(`rodizio: ${e.message}`);
    process.exitCode = 1;
  }
}
