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
btns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.theme === theme)));
}

// Restore saved theme
const saved = localStorage.getItem(STORAGE_KEY) || 'dark';
setTheme(saved);

btns.forEach(btn => {
btn.addEventListener('click', () => setTheme(btn.dataset.theme));
});

/* ── Mobile nav ── */
const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');
navToggle.addEventListener('click', () => {
const open = navLinks.classList.toggle('open');
navToggle.setAttribute('aria-expanded', String(open));
});

/* ── Scroll reveal ── */
const observer = new IntersectionObserver((entries) => {
entries.forEach(el => {
    if (el.isIntersecting) { el.target.classList.add('in'); observer.unobserve(el.target); }
});
}, { threshold: 0.1 });
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── Scroll progress bar ── */
const progressBar = document.getElementById('scrollProgress');
if (progressBar) {
  const updateProgress = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    progressBar.style.transform = `scaleX(${max > 0 ? window.scrollY / max : 0})`;
  };
  window.addEventListener('scroll', updateProgress, { passive: true });
  updateProgress();
}

/* ── Stat count-up on reveal ── */
document.querySelectorAll('.stat-num').forEach(el => {
  const target = parseInt(el.textContent.replace(/\D/g, ''), 10);
  if (!target || reducedMotion) return;
  const prefix = el.textContent.replace(/[\d,]/g, '');
  const io = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting) return;
    io.disconnect();
    const t0 = performance.now(), dur = 1100;
    (function tick(now) {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = prefix + Math.round(target * eased);
      if (p < 1) requestAnimationFrame(tick);
    })(t0);
  }, { threshold: 0.4 });
  io.observe(el);
});

/* ── Hero spotlight follows the cursor ── */
const hero = document.getElementById('hero');
if (hero && !reducedMotion && window.matchMedia('(pointer:fine)').matches) {
  hero.addEventListener('pointermove', (e) => {
    const r = hero.getBoundingClientRect();
    hero.style.setProperty('--mx', `${e.clientX - r.left}px`);
    hero.style.setProperty('--my', `${e.clientY - r.top}px`);
    hero.classList.add('spot-on');
  }, { passive: true });
  hero.addEventListener('pointerleave', () => hero.classList.remove('spot-on'));
}

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
  btn.textContent = typeof t === 'function' ? t('copy_done') : '✓ Copied';
  setTimeout(() => {
    btn.textContent = typeof t === 'function' ? t('copy') : 'Copy';
  }, 2000);
});

/* ── Copy buttons on model-guide prompt boxes ── */
document.querySelectorAll('.mg-prompt').forEach(box => {
  const label = box.querySelector('.mg-prompt-label');

  // The text to copy = the prompt body, excluding the old label.
  const clone = box.cloneNode(true);
  const cl = clone.querySelector('.mg-prompt-label');
  if (cl) cl.remove();
  const text = clone.textContent.trim();
  if (!text) return;

  // Keep a gentle hint for prompts that need an image attached.
  const note = label && /image|photo/i.test(label.textContent) ? '📎 Attach an image first' : '';

  const bar = document.createElement('div');
  bar.className = 'mg-prompt-bar';
  const noteEl = document.createElement('span');
  noteEl.className = 'mg-prompt-note';
  noteEl.textContent = note;
  bar.appendChild(noteEl);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'prompt-copy';
  btn.textContent = 'Copy';
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(text);
    btn.textContent = '✓ Copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
  bar.appendChild(btn);

  if (label) label.replaceWith(bar);
  else box.prepend(bar);
});




