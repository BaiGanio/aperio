(function () {
  if (!window.speechSynthesis) return;

  const LOCALE_MAP = {
    en: 'en-US', bg: 'bg-BG', de: 'de-DE', fr: 'fr-FR',
    es: 'es-ES', it: 'it-IT', nl: 'nl-NL', pl: 'pl-PL',
    pt: 'pt-PT', ro: 'ro-RO', cs: 'cs-CZ', da: 'da-DK',
    el: 'el-GR', et: 'et-EE', fi: 'fi-FI', ga: 'ga-IE',
    hr: 'hr-HR', hu: 'hu-HU', lt: 'lt-LT', lv: 'lv-LV',
    mt: 'mt-MT', sk: 'sk-SK', sl: 'sl-SI', sv: 'sv-SE',
  };

  let enabled = localStorage.getItem('aperio-tts') === 'true';

  function getLang() {
    const short = window.Aperio?.getCurrentLang?.() || 'en';
    return LOCALE_MAP[short] || 'en-US';
  }

  function stripMarkdown(text) {
    return text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ')
      .replace(/!\[.*?\]\(.*?\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/[*_]{1,3}([^*_\n]+)[*_]{1,3}/g, '$1')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/^\s*>\s+/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function speak(text) {
    if (!enabled) return;
    window.speechSynthesis.cancel();
    const clean = stripMarkdown(text);
    if (!clean) return;
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = getLang();
    utterance.onend = () => window.Aperio?.voice?.onTtsEnd?.();
    window.speechSynthesis.speak(utterance);
  }

  function stop() {
    window.speechSynthesis.cancel();
  }

  function toggle() {
    enabled = !enabled;
    localStorage.setItem('aperio-tts', enabled ? 'true' : 'false');
    if (!enabled) window.speechSynthesis.cancel();
    updateBtn();
  }

  function updateBtn() {
    const btn = document.getElementById('ttsToggle');
    const lbl = document.getElementById('ttsToggleLabel');
    if (!btn) return;
    btn.style.opacity = enabled ? '1' : '0.45';
    btn.style.color   = enabled ? 'var(--text)' : 'var(--text-muted)';
    if (lbl) lbl.textContent = enabled ? 'on' : 'off';
    btn.title = enabled ? 'Voice responses on — click to mute' : 'Voice responses off — click to enable';
  }

  window.addEventListener('DOMContentLoaded', updateBtn);

  window.Aperio = window.Aperio || {};
  window.Aperio.tts = { speak, stop, toggle };
})();
