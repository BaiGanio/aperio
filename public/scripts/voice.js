(function () {
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Speech) return;

  const micBtn    = document.getElementById('micBtn');
  const chatInput = document.getElementById('chatInput');
  if (!micBtn || !chatInput) return;

  micBtn.style.display = 'flex';

  const LOCALE_MAP = {
    en: 'en-US', bg: 'bg-BG', de: 'de-DE', fr: 'fr-FR',
    es: 'es-ES', it: 'it-IT', nl: 'nl-NL', pl: 'pl-PL',
    pt: 'pt-PT', ro: 'ro-RO', cs: 'cs-CZ', da: 'da-DK',
    el: 'el-GR', et: 'et-EE', fi: 'fi-FI', ga: 'ga-IE',
    hr: 'hr-HR', hu: 'hu-HU', lt: 'lt-LT', lv: 'lv-LV',
    mt: 'mt-MT', sk: 'sk-SK', sl: 'sl-SI', sv: 'sv-SE',
  };

  let recognition   = null;
  let isListening   = false;
  let silenceTimer  = null;
  const SILENCE_MS  = 1500;

  function getLang() {
    const short = window.Aperio?.getCurrentLang?.() || 'en';
    return LOCALE_MAP[short] || 'en-US';
  }

  function startListening() {
    recognition = new Speech();
    recognition.continuous      = true;
    recognition.interimResults  = true;
    recognition.lang            = getLang();

    recognition.onresult = (e) => {
      let transcript = '';
      let isFinal    = false;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript;
        if (e.results[i].isFinal) isFinal = true;
      }
      chatInput.value = transcript;
      chatInput.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof window.autoResize === 'function') window.autoResize();

      if (silenceTimer) clearTimeout(silenceTimer);
      if (isFinal) {
        silenceTimer = setTimeout(() => {
          if (chatInput.value.trim() && typeof window.send === 'function') {
            window.send();
          }
          stopListening();
        }, SILENCE_MS);
      }
    };

    recognition.onerror = () => stopListening();
    recognition.onend   = () => { if (isListening) stopListening(); };

    try {
      recognition.start();
      isListening = true;
      micBtn.classList.add('listening');
      micBtn.title = 'Listening… click to stop';
    } catch (err) {
      console.warn('Voice start failed:', err);
    }
  }

  function stopListening() {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    if (recognition) {
      try { recognition.stop(); } catch {}
      recognition = null;
    }
    isListening = false;
    micBtn.classList.remove('listening');
    micBtn.title = 'Voice input';
  }

  micBtn.addEventListener('click', () => {
    if (isListening) {
      stopListening();
      if (chatInput.value.trim() && typeof window.send === 'function') {
        window.send();
      }
    } else {
      startListening();
    }
  });

  // Typing while mic is active cancels voice so user can edit freely
  chatInput.addEventListener('keydown', () => {
    if (isListening) stopListening();
  });

  // Cmd+Shift+M / Ctrl+Shift+M toggles mic from anywhere
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'm') {
      e.preventDefault();
      micBtn.click();
    }
  });
})();
