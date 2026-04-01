/* ── Theme switcher ── */
const root = document.documentElement;
const btns = document.querySelectorAll('.theme-btn');
const STORAGE_KEY = 'aperio-landing-theme';
const version = '0.0.0'
/* ── Version ── */
/* document.getElementById('version-display').innerText = version;   */

function setTheme(theme) {
root.setAttribute('data-theme', theme);
localStorage.setItem(STORAGE_KEY, theme);
btns.forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
}

// Restore saved theme
const saved = localStorage.getItem(STORAGE_KEY) || 'dark';
setTheme(saved);

btns.forEach(btn => {
btn.addEventListener('click', () => setTheme(btn.dataset.theme));
});

/* ── Mobile nav ── */
document.getElementById('navToggle').addEventListener('click', () => {
document.getElementById('navLinks').classList.toggle('open');
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


