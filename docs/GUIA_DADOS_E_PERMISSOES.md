# Guia de Dados e Permissoes

Ultima revisao: 19/09/2026

Este guia explica as tabelas, relacoes, regras de acesso e pontos de cuidado ao mexer em dados.

Fonte de verdade tecnica: `src/database.js`.

## Principios

- PostgreSQL e a fonte de verdade.
- Alteracoes de schema devem ser idempotentes.
- Historicos importantes nao devem ser apagados.
- Usuarios sao desativados logicamente.
- Membros inativos somem das listas operacionais, mas historico continua.
- Evite cache global para regras de permissao sem TTL e invalidacao.
- Evite duplicar estado quando a informacao pode ser derivada do historico.

## Dominios e tabelas

Identidade:

- `member`
- `user`

Projetos:

- `project`
- `project_members`

Atas:

- `ata`
- `ata_present_members`
- `ata_absent_justification`

Relatorios e metas:

- `report_entry`
- `report_week_goal`
- `report_week_goal_deletion_log`
- `report_fortnight_tutor_note`
- `report_fortnight_member_note`

Advertencias:

- `member_warning_event`
- `member_warning_restriction`
- `member_warning_cycle`

Planner:

- `planner_task`
- `planner_task_completion_log`
- `task_audit_log`

Almoxarifado:

- `estoque`
- `pedido`
- `inventory_category`
- `inventory_location`
- `inventory_loan`

Presenca:

- `attendee`
- `event`
- `event_attendee`
- `event_attendance`

Escrita:

- `writing_general_entry`
- `writing_tutor_private_entry`

Chat/notificacao:

- `chat_conversation`
- `chat_conversation_participant`
- `chat_message`
- `notification_email_delivery`

## Relacoes centrais

- `user.member_id -> member.id`
- `project_members.project_id -> project.id`
- `project_members.member_id -> member.id`
- `ata.project_id -> project.id`
- `ata_present_members.ata_id -> ata.id`
- `ata_absent_justification.ata_id -> ata.id`
- `report_entry.member_id -> member.id`
- `report_entry.project_id -> project.id`
- `report_week_goal.member_id -> member.id`
- `report_week_goal.project_id -> project.id`
- `report_week_goal.planner_task_id -> planner_task.id`
- `planner_task.project_id -> project.id`
- `planner_task.assigned_member_id -> member.id`
- `inventory_loan.item_id -> estoque.id`
- `inventory_loan.user_id -> user.id`
- `pedido.estoque_id -> estoque.id`
- `pedido.usuario_id -> user.id`
- `event_attendee.event_id -> event.id`
- `event_attendee.attendee_id -> attendee.id`
- `event_attendance.event_id -> event.id`
- `event_attendance.attendee_id -> event_attendee.id`
- `chat_message.conversation_id -> chat_conversation.id`
- `chat_message.author_user_id -> user.id`

## Identidade

### `member`

Representa a pessoa acompanhada em projetos, atas, relatorios e planner.

Campos importantes:

- `id`
- `name`
- `photo`
- `is_active`

Regra:

- Inativar membro preserva historico.
- Nao remover membro com historico real sem regra explicita.

### `user`

Representa login no portal.

Campos importantes:

- `username`
- `password_hash`
- `name`
- `email`
- `role`
- `member_id`
- `is_active`

Regras:

- `role` aceita `admin`, `tutor`, `common`.
- `tutor` e tratado como admin em algumas guardas administrativas.
- Desativar usuario e preferivel a excluir.

## Projetos e permissoes de projeto

`project_members` conecta membros a projetos.

Campo importante:

- `is_coordinator`

Uso:

- Coordenador pode ter permissoes ampliadas no projeto.
- Admin/tutor normalmente consegue gerir todos os projetos.
- Membro comum atua no proprio escopo.

Ao mudar regras de projeto, revisar:

- `src/app.js`
- `src/routes/projects.js`
- `src/routes/reports.js`
- `src/routes/auth.js`

## Relatorios

Tabelas:

- `report_entry`: registros quinzenais.
- `report_week_goal`: metas/tarefas vinculadas ao relatorio.
- `report_week_goal_deletion_log`: historico de exclusao.
- `report_fortnight_tutor_note`: avaliacao privada do tutor.
- `report_fortnight_member_note`: complemento do membro.

Regras:

- Relatorios usam quinzena como unidade de trabalho.
- A primeira quinzena encerra no dia 15; a segunda encerra no ultimo dia do mes.
- Quando nao ha entrega, o registro deve indicar `Relatório não foi entregue nessa quinzena`.
- Planner e relatorios se integram por `report_week_goal.planner_task_id`.
- Exclusoes relevantes entram em log.

Cuidados:

- Evitar quebrar vinculo com planner.
- Evitar deletar logs.
- Conferir permissao de edicao ao mexer em metas.

## Advertencias

Tabelas:

- `member_warning_event`
- `member_warning_restriction`
- `member_warning_cycle`

### `member_warning_event`

Historico append-only.

Campos importantes:

- `member_id`
- `actor_user_id`
- `previous_count`
- `new_count`
- `note`
- `event_type`
- `target_event_id`
- `previous_note`
- `created_at`

Eventos comuns:

- `added`: advertencia adicionada.
- `edited`: motivo editado.
- `deleted`: advertencia removida da contagem, preservando historico.
- `cycle_reset`: zeragem automatica em ciclo semestral.
- `count_changed`: compatibilidade com fluxo antigo.

Regra de contagem:

- A quantidade atual e o `new_count` do ultimo evento daquele membro.
- A quantidade valida e de 0 a 3.
- Nao armazenar outro campo duplicado em `member`.

### `member_warning_restriction`

Registra inicio do acompanhamento/restricao de 365 dias.

Campos importantes:

- `member_id`
- `started_by_user_id`
- `started_at`
- `created_at`

Regra:

- Dias restantes sao calculados pela data atual e `started_at`.
- Nao criar job diario nem registro por dia.

### `member_warning_cycle`

Marca que o ciclo automatico ja foi aplicado em determinada data.

Datas de ciclo:

- `01/01`
- `02/07`

Regra:

- Quem tem menos de 3 advertencias zera.
- Quem tem 3 advertencias entra/inicia acompanhamento de 365 dias.
- A aplicacao do ciclo e preguicosa: acontece quando relatorios sao carregados, sem job diario.

### Permissao de advertencias

Pode visualizar:

- qualquer usuario autenticado.

Pode adicionar/editar/remover:

- somente usuario cujo membro esteja no projeto `Administrativo`.

Ao atingir exatamente 3:

- o sistema cria conversa/mensagem administrativa para todos;
- remetente: usuario `Administrativo`;
- conversa somente leitura;
- cor de tema: `#f1a7a6`;
- avatar: `app/static/img/logoadm.png`.

## Planner

Tabelas:

- `planner_task`
- `planner_task_completion_log`
- `task_audit_log`

Regras:

- Tarefas podem ser ativas, concluidas, atrasadas ou perdidas.
- Recorrencia existe em campos proprios da tarefa.
- Logs registram eventos importantes.
- Notificacoes de prazo usam consultas por data.

Cuidados:

- Evite casts em `due_at` quando comparar por string SQL ordenavel.
- Evite varrer todas as tarefas a cada request.
- Lifecycle de tarefas deve ser barato e/ou throttled.

## Atas

Tabelas:

- `ata`
- `ata_present_members`
- `ata_absent_justification`

Regras:

- Ata pertence a projeto.
- Presentes e justificativas ficam em tabelas auxiliares.
- Download PDF depende do registro completo.
- Exclusao deve respeitar permissao de projeto.

## Almoxarifado

Tabelas:

- `estoque`
- `pedido`
- `inventory_category`
- `inventory_location`
- `inventory_loan`

Regras:

- `estoque.item_type = 'stock'`: material de consumo.
- `estoque.item_type = 'patrimony'`: patrimonio emprestavel.
- Retirada de estoque gera `pedido`.
- Emprestimo de patrimonio gera `inventory_loan`.
- Devolucao soma quantidade de volta.
- Item com historico de emprestimo nao deve ser removido sem cuidado.

Permissoes:

- Consultar: autenticado.
- Criar/editar/excluir cadastro: admin/tutor.
- Retirar/emprestar/devolver: conforme regra da rota atual.

Performance:

- Listagens por aba devem carregar apenas dados necessarios.
- Historicos grandes devem usar limite quando possivel.
- Indices de `estoque`, `pedido` e `inventory_loan` sao importantes.

## Presenca

Tabelas:

- `attendee`
- `event`
- `event_attendee`
- `event_attendance`

Campos usados pela interface atual:

- Atividade: `event.name`, `event.event_date`, `event.is_active`.
- Ouvinte: `attendee.badge_code`, `attendee.name`, `attendee.cpf`, `attendee.email`.
- Vinculo: `event_attendee.event_id`, `event_attendee.attendee_id`.
- Check-in: `event_attendance.checked_in_at`, `checked_in_by_user_id`, `method`.

Regras:

- `attendee.badge_code` e unico na base geral.
- `event_attendee` impede duplicidade do mesmo ouvinte no mesmo evento.
- `event_attendance` impede presenca duplicada.
- Check-in so registra ouvintes vinculados ao evento.
- Importacao CSV aceita `cracha,nome,cpf,email`.
- Exportacao CSV usa `CRACHA,NOME,CPF,EMAIL,PRESENTE,REGISTRADO_EM`.
- Exportacao geral XLSX usa colunas por evento, marcando presenca com `X`.

Permissoes:

- Check-in: usuario autenticado.
- Criar/editar/excluir atividades: admin/tutor.
- Importar/editar/excluir ouvintes: admin/tutor.

## Chat

Tabelas:

- `chat_conversation`
- `chat_conversation_participant`
- `chat_message`

Regras:

- Participante precisa estar vinculado a conversa para ler.
- Conversas `system` podem ser somente leitura.
- Contador de nao lidas usa cache curto e invalidacao.

## Notificacoes por email

Tabela:

- `notification_email_delivery`

Uso:

- Evitar envio duplicado por `kind`, `recipient_user_id` e `reference_key`.
- Configuracao via Brevo ou provider configurado.

## Matriz pratica de permissoes

- Login: qualquer usuario ativo.
- Manutencao de usuarios: admin/tutor.
- Membros: admin/tutor.
- Projetos: autenticado cria/edita; exclusao exige admin/tutor.
- Relatorios: membro atua no proprio escopo; coordenador/admin/tutor ampliam gestao.
- Planner: segue escopo de projetos/membro e regras de coordenacao.
- Advertencias: visualizar autenticado; alterar somente membros do projeto `Administrativo`.
- Almoxarifado: consultar autenticado; cadastro administrativo para admin/tutor.
- Presenca: check-in autenticado; gestao de eventos/ouvintes para admin/tutor.
- Escrita privada: tutor.
- Chat: participantes da conversa.

## Onde revisar ao mudar permissao

- `src/app.js`
- `src/routes/auth.js`
- `src/routes/reports.js`
- `src/routes/projects.js`
- `src/routes/almox.js`
- `src/routes/presenca.js`
- `src/routes/chat.js`
- `src/routes/writing.js`
- `src/database.js`

## Checklist de alteracao de dados

1. Existe tabela/coluna nova?
2. A mudanca e idempotente?
3. Precisa de indice?
4. Precisa de mapeador?
5. Precisa de validacao?
6. Precisa de permissao nova?
7. Precisa preservar historico?
8. Precisa atualizar docs?
9. `npm run verify` passou?
