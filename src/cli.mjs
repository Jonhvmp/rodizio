import os from 'node:os';
import path from 'node:path';
import { paths } from './paths.mjs';
import { openUrl, readJson } from './util.mjs';

const HELP = `rodizio: rodízio local das contas do Claude Code

  rodizio painel               abre o painel no navegador (e religa o agente antes, se precisar)
      --url                    só mostra o endereço, com a chave de acesso
      --maquina <host>         abre aqui o painel de outra máquina, por um túnel SSH
  rodizio status               contas, uso e a conta em uso
      --json                   o estado inteiro, para outra máquina ler (Outras máquinas)
  rodizio trocar <e-mail>      troca agora para essa conta
  rodizio doctor [--reparar]   confere agente, vigia, painel, linha de status, comando e app
  rodizio atualizar            instala a versão publicada mais nova (assinada), se houver
      --verificar              só diz se há versão nova
  rodizio versao               a versão instalada
  rodizio instalar             agente e vigia no launchd (macOS), no systemd (Linux) ou no Agendador de Tarefas (Windows), linha de status, o comando e o app (no Mac e no Windows)
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

async function status(json = false) {
  const c = config();
  let s;
  try {
    s = await call('GET', '/api/state');
  } catch {
    if (json) {
      console.log(JSON.stringify({ erro: `o agente de lá não responde em 127.0.0.1:${c.port}` }));
      process.exitCode = 1;
      return;
    }
    console.log(`O agente não está respondendo em 127.0.0.1:${c.port}. Rode \`rodizio instalar\` ou veja ${path.join(paths().logs, 'agente.log')}.`);
    return;
  }
  if (json) {
    console.log(JSON.stringify(s));
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
        const at = rest.indexOf('--maquina');
        if (at >= 0) {
          const host = rest[at + 1] ?? '';
          const { openRemotePanel } = await import('./machines.mjs');
          const url = await openRemotePanel(host, { ownPort: readJson(paths().config, null)?.port ?? null });
          console.log(`Painel de ${host} aberto em ${url} (túnel SSH).`);
          return;
        }
        const { dashboardUrl, doctor, health } = await import('./install.mjs');
        const quiet = rest.includes('--url');
        let c = config();
        if (!(await health(c.port))) {
          // the agent is down or hung: put it back before opening a page that would not load
          await doctor({ repair: true, watch: true, out: (s) => (quiet ? console.error(s) : console.log(s)) });
          c = config();
        }
        const url = `${dashboardUrl(c)}#t=${c.token}`;
        if (quiet) console.log(url);
        else if (!openUrl(url)) console.log(`Painel: ${url}\nAqui não há navegador: no Mac, adicione esta máquina em "Outras máquinas", no painel de lá.`);
        return;
      }
      case 'atualizar': {
        // By hand: look now, and install unless only checking (automatic updates on or off).
        const { maybeUpdate, currentVersion } = await import('./update.mjs');
        const { restartWithNewCode } = await import('./install.mjs');
        const check = rest.includes('--verificar');
        const r = await maybeUpdate({ home: paths().home, auto: !check, apply: !check, force: true, restart: restartWithNewCode, log: (m) => console.log(m) });
        const rec = r.record;
        const text = {
          'em-dia': `Em dia: versão ${currentVersion()}.`,
          disponivel: `Versão nova disponível: ${rec.latest} (instalada: ${rec.current}). Rode \`rodizio atualizar\` para instalar.`,
          atualizado: `Atualizado para ${rec.current}.${rec.last?.notes ? `\n\n${rec.last.notes}` : ''}`,
          falhou: `Não atualizei: ${rec.why}`,
          parado: `Não dá para atualizar sozinho: ${rec.why}`,
          erro: `Não consegui procurar: ${rec.why}`,
          pulada: `${rec.latest} foi pulada porque falhou antes.`,
          ocupado: 'Já há uma atualização em andamento.',
        }[r.status];
        console.log(text ?? r.status);
        if (r.status === 'falhou' || r.status === 'erro') process.exitCode = 1;
        return;
      }
      case 'reiniciar': {
        const ok = await (await import('./install.mjs')).restartAgent();
        console.log(ok ? 'Agente de volta.' : 'O agente não respondeu.');
        process.exitCode = ok ? 0 : 1;
        return;
      }
      case 'versao':
        console.log((await import('./update.mjs')).currentVersion());
        return;
      case 'doctor': {
        // --vigia is the watchdog: it always repairs, but only what keeps the agent alive
        const watch = rest.includes('--vigia');
        return await (await import('./install.mjs')).doctor({ repair: watch || rest.includes('--reparar'), watch });
      }
      case 'status':
        return await status(rest.includes('--json'));
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
