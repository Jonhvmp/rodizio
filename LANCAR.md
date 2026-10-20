# Publicar uma versão

As instalações só aceitam versões **assinadas** por uma chave de `.github/assinaturas_permitidas` (veja
[SECURITY.md](SECURITY.md)). Publicar é um comando:

```bash
node scripts/lancar.mjs 0.6.0 "O que mudou: a troca na janela de 5 h ficou mais esperta."
```

Ele confere que você está no `main`, sem mudanças pendentes e em dia com a origem; que a chave que vai assinar está na
lista; roda os testes; atualiza a versão no `package.json`; faz o commit; cria a tag `v0.6.0` assinada, com as notas; e
envia `main` e a tag. As instalações com atualização automática recebem a versão em até 6 horas; o histórico do painel
mostra a primeira linha das notas.

## Preparar este clone (uma vez)

```bash
git config gpg.format ssh
git config user.signingkey ~/.ssh/id_ed25519.pub   # a chave listada em .github/assinaturas_permitidas
git config tag.gpgSign true
git config rodizio.desenvolvimento true            # o atualizador nunca mexe na pasta de quem desenvolve
```

## Trocar de chave

1. Acrescente a chave nova em `.github/assinaturas_permitidas` (mesmo e-mail, `namespaces="git"`).
2. Publique uma versão assinada **pela chave antiga**.
3. Depois que as instalações estiverem nela, passe a assinar com a nova (e tire a antiga numa versão seguinte).

Se a chave privada vazar, publique o quanto antes uma versão, assinada por ela mesma ou pela nova, que a tire da lista.

## Cuidados

- O que fica em `~/.rodizio` precisa continuar legível pela versão anterior (acrescente campos; não renomeie nem mude
  o sentido dos que existem): se a versão nova falhar, a anterior volta com os dados como estão.
- A versão no `package.json` e o nome da tag andam juntos; o `lancar.mjs` cuida disso, e as instalações recusam uma
  tag cujo código diga outra versão.

- Proteja a conta do GitHub com autenticação em duas etapas: quem publica no `main` decide o que as pessoas rodam.
- O CI (`.github/workflows/testes.yml`) roda os testes em macOS e Linux, com Node 20, 22 e 24, a cada push; espere
  ele passar no `main` antes de publicar.
