# Guia de Desenvolvimento

Ultima revisao: 19/09/2026

Este guia e para novos membros que precisam entender onde mexer sem quebrar o sistema. Leia junto com `README.md`, `GUIA_DADOS_E_PERMISSOES.md` e `GUIA_OPERACAO.md`.

## Visao geral da arquitetura

Fluxo principal:

1. `server.js` inicia o servidor.
2. `src/app.js` cria o app Express, configura middlewares, Nunjucks, sessao, CSRF, helpers e registra rotas.
3. `src/routes/*` concentra rotas por dominio.
4. `src/services/*` concentra regras reutilizaveis.
5. `src/validators/*` valida entradas de formularios/APIs.
6. `src/database.js` concentra schema, migracoes idempotentes, consultas e mapeadores.
7. `app/templates/*` contem as telas Nunjucks.
8. `app/static/*` contem CSS, JS publico e imagens estaticas.

O projeto ainda e propositalmente simples: muitas regras ficam em `src/database.js` e `src/app.js`. Evite refatorar em massa no meio de uma mudanca funcional pequena.

## Estrutura de diretorios

- `src/app.js`: composicao do app, middlewares, helpers globais e renderizadores compartilhados.
- `src/config.js`: variaveis de ambiente e configuracoes.
- `src/database.js`: schema, SQL, migrations idempotentes, funcoes exportadas para rotas.
- `src/http.js`: inicializacao HTTP.
- `src/media.js`: uploads locais/Cloudinary.
- `src/pdf.js`: geracao de PDF de atas.
- `src/badges.js`: geracao de crachas.
- `src/routes/`: rotas HTTP por modulo.
- `src/services/`: servicos de dominio.
- `src/validators/`: validadores de formularios.
- `app/templates/`: paginas Nunjucks.
- `app/templates/partials/`: componentes compartilhados de template.
- `app/static/css/`: estilos globais e por modulo.
- `app/static/js/`: scripts publicos.
- `app/static/img/`: imagens estaticas usadas pela UI.
- `scripts/`: rotinas de manutencao/verificacao.
- `docs/`: documentacao.
- `assets/misc/`: imagens soltas ou de origem.
- `data/examples/`: exemplos sem dados reais sensiveis.

## Entrada e middlewares

Arquivos principais:

- `server.js`
- `src/http.js`
- `src/app.js`
- `src/config.js`

Coisas importantes em `src/app.js`:

- Static files em `/static` devem ficar cedo na cadeia para evitar custo desnecessario de sessao/DB em CSS/JS/imagens.
- `requireAuth`, `requireAdminPage` e `requireAdminApi` protegem rotas.
- Helpers como `urlFor`, `mediaUrl`, filtros de data e dados de usuario sao expostos aos templates.
- Caches por requisicao reduzem consultas repetidas.
- `REQUEST_LOGS=1` mostra tempos de rota para diagnostico.

Evite colocar consulta de banco em middleware global, porque ela roda em quase toda requisicao autenticada.

## Banco e persistencia

Arquivo principal:

- `src/database.js`

Padrao atual:

- PostgreSQL e fonte de verdade.
- As rotas chamam funcoes assincronas com `await`.
- `src/postgres.js` usa `pg.Pool`; a ponte sincronizada por worker foi removida.
- `await ensureSchema()` cria tabelas, indices e colunas de forma idempotente.
- `await createApp()` prepara a aplicacao antes de `listen()`.
- `withTransaction()` propaga a conexao por `AsyncLocalStorage`: helpers internos participam do mesmo commit/rollback. As transacoes de escrita legadas usam um advisory lock para preservar a exclusao mutua de operacoes compostas.
- Nao use `forEach(async ...)` nem `filter(async ...)`. Use `for...of` com `await`, os helpers de `src/asyncArray.js`, ou `Promise.all` apenas para leituras independentes.
- `src/asyncHttp.js` encaminha rejeicoes de rotas e middlewares ao handler de erro do Express 4.
- `src/databaseAsync.js` e apenas um alias de compatibilidade; novas funcoes pertencem a `src/database.js`.

Quando adicionar tabela/coluna:

1. Adicione no bloco `CREATE TABLE IF NOT EXISTS`.
2. Se for coluna nova em tabela existente, use `ensureColumn`.
3. Crie indices necessarios.
4. Atualize mapeadores `map*`.
5. Exporte a funcao nova em `module.exports`.
6. Atualize docs de dados/permissoes se mudar regra.
7. Rode `npm run verify`.

Cuidados de performance:

- Evite `CAST(coluna AS timestamp)` em filtros/ordenacoes quando a coluna ja esta em formato SQL ordenavel.
- Evite `LOWER(coluna)` em `ORDER BY` quando isso impedir uso de indice em listagens grandes.
- Prefira consultas em lote e joins a loops com chamadas repetidas.
- Use limite (`LIMIT`) em historicos, notificacoes e listas recentes quando a tela nao precisa de tudo.

## Templates e CSS

Templates ficam em:

- `app/templates/base.html`
- `app/templates/reports/index.html`
- `app/templates/planner/index.html`
- `app/templates/almoxarifado/index.html`
- `app/templates/presenca/*`
- `app/templates/chat/index.html`
- `app/templates/users_maintenance/index.html`

CSS principal:

- `app/static/css/admin_dashboard_style.css`: shell/base antiga.
- `app/static/css/custom_styles.css`: maior parte do visual atual.
- `app/static/css/app_polish.css`: polimentos finais carregados depois de `custom_styles.css`.
- `app/static/css/almoxarifado.css`: visual do almoxarifado.
- `app/static/css/chat.css`: visual do chat.
- `app/static/css/login.css`: login.
- `app/static/css/services.css`: tela de servicos.

Importante:

- `app_polish.css` carrega depois de `custom_styles.css`; se uma regra nao aplicar, confira a ordem.
- Tema escuro usa classes `body.theme-dark.section-*`.
- Cada pagina define `activeSection` no render. Isso gera classes como `section-reports`, `section-presenca`, `section-almox`.
- Evite estilos inline novos. Ha alguns antigos; quando possivel, cubra via classes.

## Mapa rapido por modulo

### Auth, sessao e usuarios

- Rotas: `src/routes/auth.js`, partes de `src/routes/almox.js` para manutencao de usuarios.
- Templates: `app/templates/login.html`, `app/templates/users_maintenance/index.html`.
- CSS: `app/static/css/login.css`, `custom_styles.css`.
- Banco: funcoes de `user` em `src/database.js`.

Mudancas comuns:

- campo de login;
- regra de senha;
- criacao/reset de usuario;
- usuario vinculado a membro.

### Relatorios

- Rotas: `src/routes/reports.js`.
- Render principal: `renderReportPage` em `src/app.js`.
- Template: `app/templates/reports/index.html`.
- Banco: `report_entry`, `report_week_goal`, logs e funcoes relacionadas em `src/database.js`.
- Validacao: `src/validators/reportValidators.js`.

Cuidados:

- Relatorios e planner sao integrados por `planner_task_id`.
- A quinzena fecha no dia 15 ou no ultimo dia do mes; sem entrega, marque como nao entregue.
- Nao carregar listas pesadas sem necessidade.
- O template e grande; alteracoes devem ser localizadas.

### Advertencias

- Template: `app/templates/reports/index.html`.
- Rotas: `src/routes/reports.js`.
- Banco: `member_warning_event`, `member_warning_restriction`, `member_warning_cycle`.
- Chat administrativo: `src/routes/chat.js` e funcoes de conversa em `src/database.js`.
- Imagem: `app/static/img/logoadm.png`.

Regras:

- Quantidade atual deriva do historico.
- Somente membros do projeto `Administrativo` alteram advertencias.
- Todos podem visualizar a quantidade atual.
- Historico e append-only.
- Quantidade valida: 0 a 3.
- Ao atingir exatamente 3, cria mensagem administrativa para todos.
- Em 01/01 e 02/07:
  - quem tem menos de 3 zera;
  - quem tem 3 entra/inicia acompanhamento de 365 dias.
- O ciclo nao roda como job diario; e aplicado de forma preguicosa quando relatorios sao carregados.

### Planner

- Rotas: `src/routes/auth.js`.
- Template: `app/templates/planner/index.html`.
- Banco: `planner_task`, `planner_task_completion_log`, `task_audit_log`.
- Notificacoes: `src/services/notificationService.js`, `scripts/run-notifications.js`.

Cuidados:

- Evite varrer todas as tarefas em cada carregamento.
- Filtros por mes/projeto/membro devem limitar consultas.
- Se mexer em atrasos/conclusoes, revisar logs de auditoria.

### Atas

- Rotas: `src/routes/atas.js`.
- Templates: `app/templates/home.html`, `app/templates/atas/create_form.html`.
- PDF: `src/pdf.js`.
- Banco: `ata`, `ata_present_members`, `ata_absent_justification`.

Cuidados:

- Respeitar permissao de projeto.
- Nao apagar historico sem regra clara.
- PDF depende de dados de projeto, data, presentes e justificativas.

### Almoxarifado

- Rotas: `src/routes/almox.js`.
- Servico: `src/services/inventoryService.js`.
- Validador: `src/validators/inventoryValidators.js`.
- Template: `app/templates/almoxarifado/index.html`.
- CSS/JS: `app/static/css/almoxarifado.css`, `app/static/js/almoxarifado.js`.
- Banco: `estoque`, `pedido`, `inventory_category`, `inventory_location`, `inventory_loan`.

Cuidados:

- Itens podem ser `stock` ou `patrimony`.
- Estoque sai por retirada.
- Patrimonio sai por emprestimo e volta por devolucao.
- A pagina carrega dados por aba; nao volte a carregar tudo sempre.
- Historicos grandes devem ter limite quando possivel.

### Presenca

- Rotas: `src/routes/presenca.js`.
- Templates: `app/templates/presenca/*`.
- Partial de abas: `app/templates/partials/presenca_tabs.html`.
- Banco: `attendee`, `event`, `event_attendee`, `event_attendance`.
- Crachas: `src/badges.js`.

Fluxo:

1. Criar atividade em `/presenca/eventos`.
2. Cadastrar/importar ouvintes em `/presenca/ouvintes`.
3. Selecionar atividade e vincular ouvintes.
4. Fazer check-in em `/presenca/check-in`.
5. Exportar CSV da atividade ou XLSX geral.

Cuidados:

- Check-in deve continuar rapido.
- `event_attendance` impede duplicidade.
- CSV de importacao esperado: `cracha,nome,cpf,email`.
- Tema escuro tem muitos componentes; sempre testar `eventos`, `ouvintes`, `check-in` e `crachas`.

### Chat

- Rotas: `src/routes/chat.js`.
- Template: `app/templates/chat/index.html`.
- CSS: `app/static/css/chat.css`.
- Banco: `chat_conversation`, `chat_conversation_participant`, `chat_message`.

Cuidados:

- Conversas administrativas podem ser somente leitura.
- Contador de nao lidas tem cache curto em memoria.
- Ao enviar mensagem ou marcar como lida, invalidar caches relacionados.

### Escrita

- Rotas: `src/routes/writing.js` e partes de `src/routes/reports.js`.
- Template: `app/templates/writing/index.html`.
- Banco: `writing_general_entry`, `writing_tutor_private_entry`, `report_fortnight_tutor_note`, `report_fortnight_member_note`.

Regras:

- Escrita privada exige tutor.
- Complementos da quinzena podem ser bloqueados quando a quinzena fecha.
- Algumas mensagens podem ser enviadas ao chat.

### Projetos e membros

- Rotas: `src/routes/projects.js`, `src/routes/members.js`.
- Templates: `app/templates/projects/*`, `app/templates/members/*`.
- Banco: `project`, `member`, `project_members`.

Cuidados:

- Projetos possuem membros e coordenadores.
- Membros podem ficar inativos.
- Usuarios podem ser vinculados a membros.

## Checklist antes de alterar algo

1. Identifique o modulo.
2. Ache rota, template, CSS e funcoes de banco.
3. Veja se existe validador/servico.
4. Preserve nomes de campos usados em forms.
5. Confira permissao.
6. Evite refatorar arquivos grandes sem necessidade.
7. Rode `npm run verify`.
8. Faca smoke test manual da tela afetada.
9. Atualize docs se mudar regra ou fluxo.

## Checklist de UI

- Testar desktop e mobile.
- Testar tema claro e escuro.
- Confirmar que textos nao estouram botoes/cards.
- Confirmar que modais fecham por botao, backdrop e `Esc`.
- Confirmar que formulario mostra erros.
- Evitar card dentro de card sem necessidade.
- Manter padrao visual do modulo.

## Checklist de performance

- A rota adicionou consultas?
- Alguma consulta roda dentro de loop?
- A consulta precisa de indice?
- A pagina precisa carregar todos os dados ou so a aba atual?
- Isso roda em middleware global?
- Historico/lista tem limite?
- Existe cache por requisicao reaproveitavel?

## Comandos uteis

```bash
npm run dev
npm start
npm run verify
npm run notify:run-once
npm test
```

Logs de rota:

```bash
REQUEST_LOGS=1 npm run dev
```

## Melhorias futuras recomendadas

- Dividir `src/database.js` por dominio mantendo contratos publicos.
- Dividir `app/templates/reports/index.html` em partials.
- Criar testes focados para validadores e regras de permissao.
- Criar metricas simples para rotas pesadas.
- Reduzir estilos inline antigos em templates de presenca.
- Substituir gradualmente o advisory lock global por locks de linha especificos, com testes de concorrencia por dominio.

## Testes da migracao assincrona

`npm test` executa verificacoes de advertencias e uma integracao em schema temporario. Cobre rollback, event loop livre durante SQL, concorrencia de estoque e advertencias, tarefas/relatorios, mensagens, presenca e paginas HTTP autenticadas. O schema e removido em `finally`, inclusive quando uma assercao falha. Nao execute `scripts/verify-app.js` diretamente contra dados reais: ele e o teste interno chamado pela rotina isolada.

O pool e encerrado nos scripts e no desligamento do servidor. `PG_POOL_MAX` vale por processo; dimensione o total considerando todas as instancias da aplicacao.
