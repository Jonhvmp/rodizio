# Segurança

O rodízio mexe no login do Claude Code. Por isso ele foi feito para que **nada seu saia do seu Mac** e para que nenhum
outro programa, site ou pessoa consiga usá-lo por você.

## O que ele guarda e onde

| O quê | Onde | Quem consegue ler |
|---|---|---|
| Login de cada conta | Keychain do macOS, na entrada que o próprio Claude Code cria para a pasta da conta (`Claude Code-credentials-<hash>`) | O seu usuário do Mac, como o login do próprio Claude Code |
| Contas, uso, histórico, regras | `~/.rodizio/` (pasta 0700, arquivos 0600) | O seu usuário do Mac |
| Chave de acesso do painel | `~/.rodizio/config.json` e o armazenamento local do navegador que abriu o painel | O seu usuário do Mac |

Não existe servidor do rodízio, conta no rodízio nem telemetria. Não há dependências npm.

## O que sai para a rede

Só para a Anthropic, com o token de cada conta, e sempre se identificando como `rodizio/<versão>`:

- o login oficial, feito pelo próprio Claude Code (`claude auth login`);
- `GET api.anthropic.com/api/oauth/profile`, para saber de quem é o login que está no Claude Code;
- `GET api.anthropic.com/api/oauth/usage`, para ler o uso de cada conta (dá para desligar no painel).

E para a origem do clone (o GitHub), a cada 6 h, só para ver se há versão nova: `git ls-remote` com os nomes das
tags e, quando há uma, o `git fetch` dela. Dá para desligar em **Regras → Atualizar sozinho**.

## Atualizações automáticas

Um programa que se atualiza sozinho na máquina de outras pessoas tem os logins delas ao alcance. Por isso cada versão
nova passa por estas travas antes de rodar (veja `src/update.mjs`):

1. **Só versões publicadas**: uma tag `vX.Y.Z` alcançável pelo `main` da origem. Um push qualquer não instala nada.
2. **Só assinadas por uma chave confiável**: a assinatura SSH da tag é conferida com `git verify-tag` (pelo
   `ssh-keygen`, ignorando as configurações do git do usuário e do sistema) contra `.github/assinaturas_permitidas`
   **da versão já instalada**, copiado antes de qualquer download. Quem tomasse conta do repositório (ou da rede) não
   teria a chave privada do autor, e a versão seria recusada.
3. **Só a versão que diz ser**: a tag precisa ter sido assinada com esse mesmo nome e apontar para um commit cujo
   `package.json` traz essa mesma versão. Uma tag assinada de outra coisa (um teste, uma versão antiga) não passa
   por uma versão nova.
4. **Só para a frente**: a versão nova precisa conter a instalada (nunca outro ramo, nunca uma versão mais velha).
5. **Só em pasta intacta**: com mudanças locais no código, ou numa pasta marcada como de desenvolvimento
   (`git config rodizio.desenvolvimento true`), nada é trocado.
6. **Uma de cada vez, sobre o que foi conferido**: a versão é baixada para refs próprias e resolvida uma vez só; as
   conferências e a troca usam esses mesmos objetos. Duas atualizações nunca rodam juntas, e nenhum hook roda.
7. **Volta sozinha**: a versão nova precisa responder com o próprio número e continuar no mesmo processo 30 s depois.
   Se não, a anterior volta e a nova é pulada; se nem a volta der certo, ela é tentada de novo na próxima passada do
   vigia.

Troca de chave do autor: uma versão assinada pela chave antiga acrescenta a nova em `.github/assinaturas_permitidas`;
só então versões assinadas pela nova são aceitas.

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
