/*
 * ARQUIVO: admin_dashboard_script.js
 * FUNCAO: comportamento da navegacao lateral (item ativo por hover e toggle responsivo do menu).
 * IMPACTO DE MUDANCAS:
 * - Alterar seletores/classes exige manter consistencia com HTML e CSS da estrutura de layout.
 * - Alterar a logica de toggle pode quebrar usabilidade em telas menores.
 */
// add hovered class to selected list item
// SECAO: seletores da navegacao lateral e estados interativos de hover.

let list = document.querySelectorAll(".navigation li");

// SECAO: realce visual do item atualmente percorrido na sidebar.

function activeLink() {
  list.forEach((item) => {
    item.classList.remove("hovered");
  });
  this.classList.add("hovered");
}

list.forEach((item) => item.addEventListener("mouseover", activeLink));

// Menu Toggle
// SECAO: toggle responsivo da barra lateral (expande/recolhe layout principal).

let toggle = document.querySelector(".toggle");
let navigation = document.querySelector(".navigation");
let main = document.querySelector(".main");
let toggleIcon = toggle ? toggle.querySelector("ion-icon") : null;

function syncNavigationState() {
  if (!navigation || !main) {
    return;
  }
  const isOpen = navigation.classList.contains("active");
  document.body.classList.toggle("nav-open", isOpen);
  if (toggle) {
    toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    toggle.setAttribute("aria-label", isOpen ? "Fechar menu de navegação" : "Abrir menu de navegação");
  }
  if (toggleIcon) {
    toggleIcon.setAttribute("name", isOpen ? "close-outline" : "menu-outline");
  }
}

function toggleNavigation() {
  if (!navigation || !main) {
    return;
  }
  navigation.classList.toggle("active");
  main.classList.toggle("active");
  syncNavigationState();
}

function closeNavigation() {
  if (!navigation || !main || !navigation.classList.contains("active")) {
    return;
  }
  navigation.classList.remove("active");
  main.classList.remove("active");
  syncNavigationState();
}

function syncScrollState() {
  const isScrolled = window.scrollY > 18;
  document.body.classList.toggle("scrolled-down", isScrolled);
}

if (toggle && navigation && main) {
  toggle.onclick = function () {
    toggleNavigation();
  };

  toggle.addEventListener("keydown", function(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleNavigation();
    }
  });
}

document.addEventListener("keydown", function(event) {
  if (event.key === "Escape") {
    closeNavigation();
  }
});

document.addEventListener("click", function(event) {
  if (
    document.body.classList.contains("nav-open")
    && window.matchMedia("(max-width: 1100px)").matches
    && navigation
    && toggle
    && !navigation.contains(event.target)
    && !toggle.contains(event.target)
  ) {
    closeNavigation();
  }
});

syncNavigationState();
syncScrollState();
window.addEventListener("scroll", syncScrollState, { passive: true });
