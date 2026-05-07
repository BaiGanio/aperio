/* ── Theme switcher ── */
const root = document.documentElement;
const STORAGE_KEY = 'aperio-landing-theme';
const version = '0.0.0';
/* theme buttons only (elements that carry theme data)
  Accept both the legacy `data-theme` and the new `data-theme-choice` */
const themeButtons = document.querySelectorAll('button[data-theme], button[data-theme-choice]');
const themeToggle = document.getElementById('themeDropdown');
const THEME_ICONS = { dark: '🌙', light: '☀️', aurora: '✨', system: '📀' };

function setTheme(theme) {
  root.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_KEY, theme);
  themeButtons.forEach(b => {
    const btnTheme = b.dataset.themeChoice ?? b.dataset.theme;
    b.classList.toggle('active', btnTheme === theme);
  });
  if (themeToggle) themeToggle.innerHTML = THEME_ICONS[theme] || THEME_ICONS.dark;
}

// Restore saved theme
const saved = localStorage.getItem(STORAGE_KEY) || 'dark';
setTheme(saved);

themeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const theme = btn.dataset.themeChoice ?? btn.dataset.theme;
    if (!theme) return;
    setTheme(theme);
  });
});

/* ── Mobile nav ── */
document.getElementById('navToggle').addEventListener('click', () => {
document.getElementById('navLinks').classList.toggle('open');
});

// Close hamburger menu when any anchor link inside is clicked (mobile).
// Buttons (theme/lang toggles and submenu items) should NOT close the menu.
document.querySelectorAll('#navLinks a[href^="#"]').forEach(el => {
  el.addEventListener('click', () => {
    const nav = document.getElementById('navLinks');
    if (nav && nav.classList.contains('open')) nav.classList.remove('open');
  });
});

// Mobile dropdown toggles inside the hamburger menu (keeps hamburger open)
document.querySelectorAll('.mobile-dropdown-toggle').forEach(toggle => {
  toggle.addEventListener('click', () => {
    const li = toggle.closest('.mobile-dropdown');
    if (!li) return;
    const submenu = li.querySelector('.mobile-submenu');
    const isOpen = li.classList.toggle('open');
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (submenu) submenu.hidden = !isOpen;
  });
});

/* ── Scroll reveal ── */
const observer = new IntersectionObserver((entries) => {
entries.forEach(el => {
    if (el.isIntersecting) { el.target.classList.add('in'); observer.unobserve(el.target); }
});
}, { threshold: 0.1 });
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

/* ── Active nav highlight ── */
const sections = document.querySelectorAll('section[id]');
const navAs = document.querySelectorAll('.nav-links a[href^="#"]');
window.addEventListener('scroll', () => {
let current = '';
sections.forEach(s => { if (window.scrollY >= s.offsetTop - 80) current = s.id; });
navAs.forEach(a => { a.style.color = a.getAttribute('href') === '#' + current ? 'var(--purple)' : ''; });
}, { passive: true });

document.addEventListener('click', e => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const selector = btn.dataset.target;
  const cmds = [...btn.closest('.code-block').querySelectorAll(selector)]
    .map(el => el.textContent)
    .join('\n');
  navigator.clipboard.writeText(cmds);
  btn.textContent = '✓ Copied';
  setTimeout(() => btn.textContent = 'Copy', 2000);
});


