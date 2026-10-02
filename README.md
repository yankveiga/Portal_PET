# Portal PET C3

Aplicação interna em Node.js + Express + Nunjucks para centralizar rotinas do PET C3: relatórios, planner, atas, almoxarifado, presença, mensagens e manutenção administrativa.

## Interface

![Tela de login](docs/tela_login.png)

![Relatórios quinzenais em tema claro](docs/relatorios_tema_claro.png)

![Relatórios quinzenais em tema escuro](docs/relatorios_tema_escuro.png)

![Planner integrado aos relatórios](docs/planner.png)

![Almoxarifado](docs/almoxarifado.png)

## Em um minuto

| | |
| --- | --- |
| Problema | Rotinas do grupo distribuídas entre relatórios, planejamento, atas e controles administrativos. |
| Solução | Um portal com fluxos para membros e administração do PET C3. |
| Minha participação | Desenvolvimento individual da aplicação. |
| Código | [Templates das telas](app/templates/) · [Estilos e arquivos estáticos](app/static/) · [Rotas](src/routes/) |

## Interface e experiência

- O planner se conecta aos relatórios para acompanhar atividades planejadas e realizadas.
- A página inicial autenticada abre diretamente em relatórios, uma das tarefas recorrentes do grupo.
- As rotas separam atividades dos membros e funções administrativas, com permissões documentadas no [guia de dados e permissões](docs/GUIA_DADOS_E_PERMISSOES.md).

## Módulos principais

- Relatórios quinzenais por membro e projeto.
- Planner integrado aos relatórios.
- Sistema de advertências por membro, com auditoria e acompanhamento de 365 dias.
- Atas com geração de PDF.
- Almoxarifado: estoque, patrimônio, retiradas, empréstimos e histórico.
- Presença por eventos: atividades, ouvintes, importação CSV, check-in e exportação.
- Mensagens privadas e conversas administrativas somente leitura.
- Escrita geral e escrita privada de tutor.
- CRUD de membros, projetos e usuários.

Observação: o módulo PETrello não faz parte da versão atual.

## Stack

- Backend: Node.js + Express
- Templates: Nunjucks
- Banco: PostgreSQL, normalmente Neon
- Sessão: `cookie-session`
- Uploads: local ou Cloudinary
- PDF: PDFKit
- XLSX/CSV: `exceljs` e geração manual de CSV
- Deploy atual/alvo: Render, podendo rodar localmente com túnel temporário

## Requisitos

- Node.js 18+
- npm 9+
- PostgreSQL acessível por `DATABASE_URL`

## Como rodar localmente

1. Instale as dependências:

```bash
npm install
```

2. Crie um `.env` na raiz. Exemplo mínimo:

```env
NODE_ENV=development
PORT=3000
SECRET_KEY=troque-esta-chave
DATABASE_URL=postgresql://USUARIO:SENHA@HOST/DB?sslmode=verify-full
SESSION_MAX_AGE_HOURS=1
APP_TIMEZONE=America/Sao_Paulo
REPORTS_TIMEZONE=America/Sao_Paulo
APP_BASE_URL=http://127.0.0.1:3000
```

3. Opcionalmente, crie um usuário inicial:

```bash
npm run create-user
```

4. Inicie a aplicação:

```bash
npm run dev
```

URL local padrão:

```text
http://127.0.0.1:3000
```

## Scripts

```bash
npm run dev
npm start
npm run create-user
npm run verify
npm run notify:run-once
```

`npm run verify` cria um schema PostgreSQL temporario, valida os fluxos e remove o schema ao terminar. A conexao precisa de permissao para criar schemas. `npm test` inclui tambem os testes isolados de advertencias. Em Neon, a verificacao usa o endpoint direto do mesmo banco para isolar o `search_path`.

## Rotas importantes

- `/login`: entrada do sistema.
- `/relatorios`: página inicial autenticada.
- `/planner`: planner.
- `/home`: atas recentes.
- `/atas/nova`: criação de ata.
- `/almoxarifado`: almoxarifado.
- `/presenca/check-in`: check-in por crachá.
- `/presenca/eventos`: atividades de presença.
- `/presenca/ouvintes`: cadastro/importação de ouvintes.
- `/mensagens`: chat.
- `/projects`: projetos.
- `/members`: membros.
- `/manutencao-usuarios`: usuários e senhas.
- `/healthz`: healthcheck.

## Regras importantes

- Fuso principal: `America/Sao_Paulo`.
- Página inicial autenticada: `/relatorios`.
- Usuários são desativados logicamente, não apagados fisicamente, para preservar histórico.
- Membros inativos deixam de aparecer nas listas operacionais.
- Relatórios quinzenais possuem tolerância de 2 dias:
  - primeira quinzena: até o fim do dia 17;
  - segunda quinzena: até o fim do dia 02 do mês seguinte.
- O planner e os relatórios se conectam por `report_week_goal.planner_task_id`.
- Advertências são históricas e append-only: não apagar histórico.
- Presença usa PostgreSQL como fonte de verdade; CSV local é apenas contingência.
- Ouvintes de presença usam `cracha,nome,cpf,email`.

## Performance

- Todas as operacoes de banco em `src/database.js` sao assincronas e usam o pool de `src/postgres.js`. As rotas e scripts devem usar `await`.
- `PG_POOL_MAX` limita as conexoes por processo (padrao: 6); `DB_SLOW_QUERY_MS` ativa o log de duracao sem expor parametros.
- Transacoes reutilizam a mesma conexao nos helpers. As escritas compostas usam exclusao mutua transacional para preservar estoque e auditoria durante acessos concorrentes.
- Evite adicionar consultas em middleware global.
- Evite consultas dentro de loops quando uma query com join resolver.
- Telas grandes devem carregar apenas o necessário para a aba/visão atual.
- Assets estáticos ficam em `/static` e devem passar antes de middlewares caros.
- Para investigar lentidão:

```env
REQUEST_LOGS=1
```

Depois veja os tempos das rotas nos logs e compare com a latência do banco.

## Variáveis de ambiente

Obrigatórias:

- `DATABASE_URL`
- `SECRET_KEY`

Recomendadas:

- `NODE_ENV`
- `PORT`
- `SESSION_MAX_AGE_HOURS`
- `APP_BASE_URL`
- `APP_TIMEZONE`
- `REPORTS_TIMEZONE`

Bootstrap opcional:

- `BOOTSTRAP_ADMIN`
- `BOOTSTRAP_ADMIN_USERNAME`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `BOOTSTRAP_ADMIN_NAME`

Uploads opcionais:

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_FOLDER`

Email/notificações opcionais:

- `EMAIL_PROVIDER`
- `BREVO_API_KEY`
- `EMAIL_FROM`
- `EMAIL_FROM_NAME`
- `EMAIL_REPLY_TO`
- `NOTIFICATION_SWEEP_INTERVAL_MS`

Ajustes técnicos opcionais:

- `REQUEST_LOGS`
- `DB_SYNC_QUERY_TIMEOUT_MS`
- `PG_CONNECTION_TIMEOUT_MS`

## Hospedagem temporária local

Para expor o app local temporariamente:

```powershell
npm start
```

Em outro terminal:

```powershell
.\cloudflared-windows-amd64.exe tunnel --url http://localhost:3000
```

O Cloudflare gera uma URL temporária `trycloudflare.com`. Mantenha o terminal aberto enquanto precisar do túnel.

## Documentação

Leia os guias em `docs/` antes de mexer:

- [GUIA_DESENVOLVIMENTO.md](./docs/GUIA_DESENVOLVIMENTO.md): arquitetura, mapa de arquivos e como alterar com segurança.
- [GUIA_DADOS_E_PERMISSOES.md](./docs/GUIA_DADOS_E_PERMISSOES.md): tabelas, regras, permissões e advertências.
- [GUIA_OPERACAO.md](./docs/GUIA_OPERACAO.md): deploy, ambiente, incidentes, backup, presença em evento e túnel local.

## Antes de compartilhar a pasta

Não envie:

- `.env`
- `node_modules/`
- arquivos `.log`
- dumps/backups de banco
- CSVs ou planilhas com dados reais
- uploads com dados pessoais
- tokens, chaves privadas ou credenciais

Antes de entregar para outra pessoa:

```bash
npm run verify
git status --short
```

Última revisão: 25/09/2026
