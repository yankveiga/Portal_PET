# Portal PET C3

O Portal PET C3 reúne ferramentas utilizadas no dia a dia do grupo, como relatórios quinzenais, planejamento de atividades, atas, controle de estoque, presença em eventos e administração de usuários.

## Telas

![Tela de login](docs/tela_login.png)

![Relatórios quinzenais em tema claro](docs/relatorios_tema_claro.png)

![Relatórios quinzenais em tema escuro](docs/relatorios_tema_escuro.png)

![Planner integrado aos relatórios](docs/planner.png)

![Almoxarifado](docs/almoxarifado.png)

## Funcionalidades

- **Relatórios quinzenais:** registro de atividades por membro e projeto.
- **Planner:** planejamento de atividades integrado aos relatórios.
- **Advertências:** registro e acompanhamento por membro, com histórico e ciclo especial de 365 dias.
- **Atas:** criação e geração de documentos em PDF.
- **Almoxarifado:** controle de estoque, patrimônio, retiradas, empréstimos e histórico.
- **Presença:** cadastro de eventos e ouvintes, importação de CSV, check-in por crachá e exportação de dados.
- **Mensagens:** conversas privadas e comunicação administrativa.
- **Escrita:** registros gerais e anotações privadas do tutor.
- **Cadastros:** gerenciamento de membros, projetos e usuários.

O módulo PETrello não faz parte da versão atual.

## Tecnologias

- **Backend:** Node.js e Express
- **Templates:** Nunjucks
- **Banco de dados:** PostgreSQL, normalmente hospedado no Neon
- **Sessões:** `cookie-session`
- **Uploads:** armazenamento local ou Cloudinary
- **PDF:** PDFKit
- **Planilhas e CSV:** ExcelJS e geração manual de CSV

A aplicação pode ser executada localmente e está preparada para hospedagem no Render.

## Requisitos

- Node.js 18 ou superior
- npm 9 ou superior
- Acesso a um banco PostgreSQL por meio da variável `DATABASE_URL`

## Executando localmente

Clone o repositório, acesse a pasta do projeto e instale as dependências:

```bash
npm install
```

Crie um arquivo `.env` na raiz do projeto:

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

Substitua os valores de exemplo pelas configurações do seu ambiente. Consulte a seção de variáveis de ambiente e os guias em `docs/` para conhecer as demais opções.

Se necessário, crie um usuário inicial:

```bash
npm run create-user
```

Inicie a aplicação:

```bash
npm run dev
```

O endereço local padrão é http://127.0.0.1:3000.

## Scripts

| Comando | Função |
| --- | --- |
| `npm run dev` | Inicia a aplicação em desenvolvimento. |
| `npm start` | Inicia a aplicação. |
| `npm run create-user` | Cria um usuário inicial. |
| `npm run verify` | Verifica os principais fluxos da aplicação em um schema temporário do PostgreSQL. |
| `npm test` | Executa os testes, incluindo os testes isolados de advertências. |
| `npm run notify:run-once` | Executa uma rodada de notificações. |

O comando `npm run verify` precisa de permissão para criar schemas no banco. Em ambientes Neon, a verificação utiliza a conexão direta do banco para isolar o `search_path`. O schema temporário é removido ao final da execução.

## Rotas

| Rota | Descrição |
| --- | --- |
| `/login` | Login. |
| `/relatorios` | Página inicial após o login. |
| `/planner` | Planejamento de atividades. |
| `/home` | Atas recentes. |
| `/atas/nova` | Criação de atas. |
| `/almoxarifado` | Controle de estoque e patrimônio. |
| `/presenca/check-in` | Check-in por crachá. |
| `/presenca/eventos` | Gerenciamento de eventos. |
| `/presenca/ouvintes` | Cadastro e importação de ouvintes. |
| `/mensagens` | Mensagens. |
| `/projects` | Projetos. |
| `/members` | Membros. |
| `/manutencao-usuarios` | Gerenciamento de usuários e senhas. |
| `/healthz` | Verificação de disponibilidade da aplicação. |

## Regras e funcionamento

- O fuso horário principal é `America/Sao_Paulo`.
- A página inicial após o login é `/relatorios`.
- Usuários são desativados logicamente para preservar o histórico.
- Membros inativos deixam de aparecer nas listas operacionais.
- Os relatórios quinzenais seguem o calendário oficial: a primeira quinzena termina no dia 15 e a segunda, no último dia do mês.
- Complementos de relatórios ficam separados dos registros oficiais e só podem ser enviados manualmente durante a quinzena vigente.
- O planner se relaciona com os relatórios por meio de `report_week_goal.planner_task_id`.
- O histórico de advertências é preservado. Os registros não devem ser apagados.
- O PostgreSQL é a fonte oficial dos dados de presença. O CSV local serve apenas como contingência.
- O cadastro de ouvintes utiliza as colunas `cracha,nome,cpf,email`.

## Banco de dados e desempenho

As operações de banco em `src/database.js` são assíncronas e utilizam o pool de conexões definido em `src/postgres.js`. Rotas e scripts devem aguardar essas operações com `await`.

Algumas configurações disponíveis:

- `PG_POOL_MAX`: máximo de conexões por processo, com padrão de 6.
- `DB_SLOW_QUERY_MS`: limite para registrar consultas demoradas nos logs.
- `REQUEST_LOGS=1`: habilita os registros de duração das requisições.

As transações reutilizam a mesma conexão nos helpers. Operações que envolvem várias escritas utilizam exclusão mútua transacional para preservar a consistência do estoque e da auditoria em acessos simultâneos.

Ao investigar problemas de desempenho, comece pelos tempos registrados nas rotas e pela latência do banco. Evite consultas desnecessárias em middlewares globais e dentro de loops quando uma consulta com `JOIN` resolver o problema. As telas também devem carregar apenas os dados necessários para a visualização atual.

Os arquivos estáticos ficam em `/static` e devem ser servidos antes dos middlewares mais custosos, conforme a organização atual da aplicação.

## Variáveis de ambiente

**Obrigatórias**

- `DATABASE_URL`
- `SECRET_KEY`

**Aplicação e sessão**

- `NODE_ENV`
- `PORT`
- `SESSION_MAX_AGE_HOURS`
- `APP_BASE_URL`
- `APP_TIMEZONE`
- `REPORTS_TIMEZONE`

**Criação inicial de administrador**

- `BOOTSTRAP_ADMIN`
- `BOOTSTRAP_ADMIN_USERNAME`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `BOOTSTRAP_ADMIN_NAME`

**Uploads**

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_FOLDER`

**E-mail e notificações**

- `EMAIL_PROVIDER`
- `BREVO_API_KEY`
- `EMAIL_FROM`
- `EMAIL_FROM_NAME`
- `EMAIL_REPLY_TO`
- `NOTIFICATION_SWEEP_INTERVAL_MS`

**Configurações técnicas**

- `REQUEST_LOGS`
- `DB_SYNC_QUERY_TIMEOUT_MS`
- `PG_CONNECTION_TIMEOUT_MS`

Consulte os arquivos de configuração e os guias do projeto para verificar os valores padrão e quais variáveis são necessárias em cada ambiente.

## Acesso temporário pela internet

Para disponibilizar a aplicação localmente por um período curto, inicie o servidor:

```powershell
npm start
```

Em outro terminal, execute o Cloudflare Tunnel:

```powershell
.\cloudflared-windows-amd64.exe tunnel --url http://localhost:3000
```

O comando gera um endereço temporário em `trycloudflare.com`. O servidor e o túnel precisam permanecer em execução enquanto a aplicação estiver sendo utilizada.

## Documentação do projeto

Os guias em `docs/` contêm informações complementares para desenvolvimento e operação:

- [Guia de desenvolvimento](docs/GUIA_DESENVOLVIMENTO.md): arquitetura, organização dos arquivos e orientações para alterações.
- [Guia de dados e permissões](docs/GUIA_DADOS_E_PERMISSOES.md): tabelas, regras de negócio, permissões e advertências.
- [Guia de operação](docs/GUIA_OPERACAO.md): hospedagem, configuração do ambiente, incidentes, backups, presença em eventos e túnel local.

## Antes de compartilhar o projeto

Não inclua arquivos `.env`, a pasta `node_modules/`, logs, backups do banco, planilhas com dados reais, uploads com informações pessoais ou credenciais.

Antes de entregar uma versão, execute:

```bash
npm run verify
git status --short
```

Última revisão: 25/09/2026.
