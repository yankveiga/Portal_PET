(() => {
  // Seletores de elementos que podem receber a animacao de icone cobrindo o texto.
  const selector = 'button, a[class*="btn"], a[class*="button"], [role="button"]';

  // Prepara um botao/link para a animacao, criando spans de texto e icone.
  function enhance(button) {
    if (button.classList.contains('button-motion')) return;
    if (button.closest('.action-stack, .action-stack-compact, .inline-action-form, .presence-event-delete-form')) return;
    let icon = button.querySelector('ion-icon, svg, i[class*="icon"], i[class*="fa-"]');
    if (!button.textContent.trim()) return;

    // Botoes importantes sem icone recebem um ion-icon padrao conforme a acao.
    if (!icon && button.matches('.danger-button, .btn-delete, .report-goal-delete-button, .btn-download, .btn-submit, .report-inline-confirm-yes')) {
      icon = document.createElement('ion-icon');
      icon.setAttribute('name', button.matches('.danger-button, .btn-delete, .report-goal-delete-button') ? 'close-outline' : button.matches('.btn-download') ? 'download-outline' : 'checkmark-outline');
      button.append(icon);
    }
    if (!icon || button.querySelector('input, select, textarea')) return;

    // Reorganiza o conteudo sem mudar o texto exibido nem o destino do clique.
    const label = document.createElement('span');
    label.className = 'button-motion-label';
    const overlay = document.createElement('span');
    overlay.className = 'button-motion-icon';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.append(icon);
    label.append(...button.childNodes);
    button.append(label, overlay);
    button.classList.add('button-motion');
  }

  // Procura botoes em um trecho do DOM e aplica a animacao quando fizer sentido.
  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.matches(selector)) enhance(root);
    root.querySelectorAll(selector).forEach(enhance);
  }

  // Primeira varredura nos botoes que ja existem quando a pagina carrega.
  scan(document.body);

  // Mantem a animacao em botoes adicionados depois por scripts ou templates dinamicos.
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) scan(node);
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
