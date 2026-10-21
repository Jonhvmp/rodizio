# Mudanças

## 0.6.0

- **Linux**: o rodízio roda também num Linux com systemd (um servidor na nuvem, por exemplo). O login de cada conta
  fica no `.credentials.json` que o próprio Claude Code usa lá (0600); agente e vigia viram units de usuário do
  systemd; o login, sem navegador, mostra o link oficial e você cola o código longo no painel.
- **Outras máquinas**: no painel do Mac, adicione um host do seu `~/.ssh/config` com o rodízio instalado e veja de lá
  quem está com o bastão e o uso de cada conta. **Abrir painel de lá** abre o painel daquela máquina aqui, por um
  túnel SSH. `rodizio status --json`, `rodizio painel --url` e `rodizio painel --maquina <host>`.

## 0.5.0

- **A previsão aprende o seu uso**: quanto você gasta em cada hora da semana (noites e fins de semana parados
  incluídos), o ritmo de agora e quanto da janela de 5 h custa cada ponto da semana.
- **"Até a renovação"**: o painel diz se as contas duram até a semana da preferida renovar, quanto falta ou sobra, e
  quantas horas por dia você pode usar.
- **Seu padrão de uso**: um mapa da semana com o que foi aprendido.
- A linha do tempo separa uma pausa da janela de 5 h do fim da semana.
- **Atualizações automáticas e seguras**: só versões publicadas no `main`, assinadas pela chave do autor e conferidas
  contra a versão instalada; volta sozinha se o agente não subir. `rodizio atualizar`, `rodizio versao`,
  `rodizio reiniciar`.

## 0.4.0

- Primeira versão pública: troca na zona de passagem da semana e da janela de 5 h, volta para a preferida, painel ao
  vivo em 127.0.0.1, vigia, `rodizio doctor`, app Rodízio, casos de borda de rede e de sessões.
