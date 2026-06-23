/**
 * Text-to-speech — WEB UI ONLY.
 *
 * TTS is intentionally a browser feature: it relies on the Web Speech API
 * (window.speechSynthesis), which has no equivalent in the terminal. The
 * terminal chat (lib/terminal.js) has no TTS path by design — see #175 Gap 3.
 * A local/OS-binary voice for the terminal is a separate, deferred idea.
 */
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

  // Voice responses on/off. The UI control lives in the Settings panel
  // (settings-panel.js reflects this state); here we just track + persist it.
  function toggle() {
    enabled = !enabled;
    window.Aperio?.settings?.set('aperio-tts', enabled ? 'true' : 'false');
    if (!enabled) window.speechSynthesis.cancel();
  }

  window.Aperio = window.Aperio || {};
  window.Aperio.tts = { speak, stop, toggle };

  // Adopt a server value picked up at boot (settings.js has already written it
  // to localStorage before calling this).
  window.Aperio.settings?.register('aperio-tts', (val) => {
    enabled = val === 'true';
    if (!enabled) window.speechSynthesis.cancel();
  });
})();
