(function () {
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Speech) return;

  const micBtn    = document.getElementById('micBtn');
  const chatInput = document.getElementById('chatInput');
  if (!micBtn || !chatInput) return;

  // Show the mic area — prefer showing the wrapper (chip lives there),
  // fall back to showing the button directly if the wrapper isn't in the DOM.
  const micWrap = document.getElementById('micWrap');
  const chip    = document.getElementById('micContinuousChip');
  if (micWrap) {
    micWrap.style.display = 'flex';
  } else {
    micBtn.style.display = 'flex';
  }

  const LOCALE_MAP = {
    en: 'en-US', bg: 'bg-BG', de: 'de-DE', fr: 'fr-FR',
    es: 'es-ES', it: 'it-IT', nl: 'nl-NL', pl: 'pl-PL',
    pt: 'pt-PT', ro: 'ro-RO', cs: 'cs-CZ', da: 'da-DK',
    el: 'el-GR', et: 'et-EE', fi: 'fi-FI', ga: 'ga-IE',
    hr: 'hr-HR', hu: 'hu-HU', lt: 'lt-LT', lv: 'lv-LV',
    mt: 'mt-MT', sk: 'sk-SK', sl: 'sl-SI', sv: 'sv-SE',
  };

  let recognition     = null;
  let isListening     = false;
  let silenceTimer    = null;
  let continuousMode  = localStorage.getItem('aperio-voice-continuous') === 'true';
  let _pendingRestart = false;
  const SILENCE_MS    = 1500;

  function getLang() {
    const short = window.Aperio?.getCurrentLang?.() || 'en';
    return LOCALE_MAP[short] || 'en-US';
  }

  function updateChip() {
    if (!chip) return;
    chip.classList.toggle('active', continuousMode);
    chip.title = continuousMode
      ? 'Continuous voice mode on — click to disable'
      : 'Continuous voice mode — click to keep mic always on';
  }

function buildRecognition() {
    console.group('[voice] buildRecognition');
    console.log('SpeechRecognition API:', window.SpeechRecognition ? 'SpeechRecognition' : window.webkitSpeechRecognition ? 'webkitSpeechRecognition' : 'none');
    console.log('userAgent:', navigator.userAgent);
    console.log('location protocol:', location.protocol, '| host:', location.host);
    console.log('lang:', getLang());

    navigator.permissions?.query({ name: 'microphone' }).then(result => {
      console.log('[voice] mic permission state:', result.state);
    }).catch(err => {
      console.log('[voice] permissions.query not supported:', err.message);
    });

    const r = new Speech();
    r.continuous     = true;
    r.interimResults = true;
    r.lang           = getLang();
    console.groupEnd();

    r.onstart = () => console.log('[voice] onstart — recognition active');

    r.onaudiostart = () => console.log('[voice] onaudiostart — mic open');

    r.onsoundstart = () => console.log('[voice] onsoundstart — sound detected');

    r.onspeechstart = () => console.log('[voice] onspeechstart — speech detected');

    r.onspeechend = () => console.log('[voice] onspeechend');

    r.onsoundend = () => console.log('[voice] onsoundend');

    r.onaudioend = () => console.log('[voice] onaudioend — mic closed');

    r.onresult = (e) => {
      let transcript = '';
      let isFinal    = false;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript;
        if (e.results[i].isFinal) isFinal = true;
      }
      console.log('[voice] onresult — transcript:', JSON.stringify(transcript), '| isFinal:', isFinal);
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

    r.onerror = (e) => {
      console.group('[voice] onerror');
      console.error('error code:', e.error);
      console.error('message:', e.message);
      console.error('full event:', e);
      console.groupEnd();
      stopListening();
    };

    r.onend = () => {
      console.log('[voice] onend — isListening was:', isListening);
      if (isListening) stopListening();
    };

    return r;
  }

  // Start recognition synchronously (Safari requires start() inside the user
  // gesture tick; async/await breaks the gesture chain and causes service-not-allowed).
  function startListening() {
    if (isListening) return;
    console.group('[voice] startListening');
    recognition = buildRecognition();
    try {
      recognition.start();
      isListening = true;
      micBtn.classList.add('listening');
      micBtn.title = 'Listening… click to stop';
      console.log('recognition.start() called successfully');
    } catch (err) {
      console.error('recognition.start() threw:', err.name, err.message);
      recognition = null;
    }
    console.groupEnd();
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

  function onStreamEnd() {
    if (!continuousMode) return;
    if (window.speechSynthesis?.speaking) {
      _pendingRestart = true;
      return;
    }
    _pendingRestart = false;
    setTimeout(startListening, 300);
  }

  function onTtsEnd() {
    if (!continuousMode || !_pendingRestart) return;
    _pendingRestart = false;
    setTimeout(startListening, 300);
  }

  if (chip) {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      continuousMode = !continuousMode;
      window.Aperio?.settings?.set('aperio-voice-continuous', continuousMode ? 'true' : 'false');
      updateChip();
      if (continuousMode && !isListening) {
        startListening();
      } else if (!continuousMode) {
        _pendingRestart = false;
      }
    });
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

  chatInput.addEventListener('keydown', () => {
    if (isListening) stopListening();
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'm') {
      e.preventDefault();
      micBtn.click();
    }
  });

  updateChip();
  if (continuousMode) setTimeout(startListening, 500);

  window.Aperio = window.Aperio || {};
  window.Aperio.voice = { onStreamEnd, onTtsEnd };

  // Adopt a server value picked up at boot.
  window.Aperio.settings?.register('aperio-voice-continuous', (val) => {
    continuousMode = val === 'true';
    updateChip();
    if (!continuousMode) _pendingRestart = false;
  });
})();
