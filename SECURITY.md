# Segurança

O rodízio mexe no login do Claude Code. Por isso ele foi feito para que **nada seu saia do seu Mac** e para que nenhum
outro programa, site ou pessoa consiga usá-lo por você.

## O que ele guarda e onde

| O quê | Onde | Quem consegue ler |
|---|---|---|
| Login de cada conta | Keychain do macOS, na entrada que o próprio Claude Code cria para a pasta da conta (`Claude Code-credentials-<hash>`) | O seu usuário do Mac, como o login do próprio Claude Code |
| Contas, uso, histórico, regras | `~/.rodizio/` (pasta 0700, arquivos 0600) | O seu usuário do Mac |
| Chave de acesso do painel | `~/.rodizio/config.json` e o armazenamento local do navegador que abriu o painel | O seu usuário do Mac |

Não existe servidor do rodízio, conta no rodízio, telemetria nem atualização automática. Não há dependências npm.

## O que sai para a rede

Só para a Anthropic, com o token de cada conta, e sempre se identificando como `rodizio/<versão>`:

- o login oficial, feito pelo próprio Claude Code (`claude auth login`);
- `GET api.anthropic.com/api/oauth/profile`, para saber de quem é o login que está no Claude Code;
- `GET api.anthropic.com/api/oauth/usage`, para ler o uso de cada conta (dá para desligar no painel).

## O painel

- Escuta só em `127.0.0.1`, numa porta sorteada.
- Confere o cabeçalho `Host` (contra DNS rebinding) e a origem das chamadas.
- Toda chamada da API exige a chave de acesso no cabeçalho `X-Rodizio-Token`. A chave chega pelo endereço que
  `rodizio painel` abre (`#t=…`, que o navegador não envia a lugar nenhum) e fica só naquele navegador. A página em si
  não carrega segredo: outro programa do Mac que a baixe não ganha acesso.
- CSP restrita, sem recursos externos, `frame-ancestors 'none'`.

## Reportar uma vulnerabilidade

Abra uma issue **sem** detalhes que permitam explorar o problema e peça um canal privado, ou use o
[aviso privado de segurança do GitHub](../../security/advisories/new) deste repositório. Nunca cole tokens, conteúdo
do Keychain ou do `~/.rodizio` em issues.
