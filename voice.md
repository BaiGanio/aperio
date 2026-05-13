# Voice Input — Web Speech API Implementation

~40 lines JS, ~25 lines CSS, 2 lines HTML. Zero dependencies.

---

## Step 1 — Add the mic button to `public/index.html`

Inside `.input-wrap`, between the attach button and textarea:

```html
<button class="attach-btn" id="attachBtn" ...>
  <i class="bi bi-plus-lg"></i>
</button>

<!-- 👇 ADD THIS -->
<button class="mic-btn" id="micBtn" title="Voice input" style="display:none;">
  <i class="bi bi-mic"></i>
</button>

<input type="file" id="fileInput" ... hidden>
textarea id="chatInput" ...></textarea>
```

Starts hidden. JS shows it only if the browser supports SpeechRecognition.

---

## Step 2 — Add styles to `public/styles/input-bar.css`

After `.attach-btn` styles:

```css
.mic-btn {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: transparent;
  border: 1px solid var(--border);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink 0;
  transition: all var(--transition);
  color: var(--text-muted);
  font-size: 16px;
  padding: 0;
}

.mic-btn:hover {
  background: var(--bg-panel);
  border-color: var(--accent);
  color: var(--accent);
}

.mic-btn.listening {
  background: rgba(239, 68, 68, 0.12);
  border-color: #ef4444;
  color: #ef4444;
  animation: mic-pulse 1.2s ease-in-out infinite;
}

@keyframes mic-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.3); }
  50%      { box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); }
}
```

---

## Step 3 — Create `public/scripts/voice.js`

```js
// ── Voice Input ──────────────────────────────────────────────
// Web Speech API — zero dependencies, works in Brave/Chrome/Edge
(function() {
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Speech) return; // unsupported — button stays hidden

  const micBtn = document.getElementById('micBtn');
  const chatInput = document.getElementById('chatInput  if (!micBtn || !chatInput) return;

  // Show the button now that we know it works
 Btn.style.display = 'flex';

  // BCP-47 locale map: Aperio 2-letter codes → API locales
  const LOCALE_MAP = {
    en: 'en-US', bg: 'bg-BG', de: 'de-DE', fr: 'fr-FR',
    es: 'es-ES', it: 'itIT', nl: 'nl-NL', pl: 'pl-PL',
    pt: 'pt-PT', ro: 'ro-RO', cs: 'cs-CZ', da: 'da-DK',
    el: 'el-GR', 'et-EE', fi: 'fi-FI', ga: 'ga-IE',
    hr: 'hr-HR', hu: 'hu-HU', lt: 'lt-LT', lv: 'lv-LV',
    mt: 'mt-MT', sk: 'sk-SK', sl: 'sl-SI', sv: 'sv-SE',
  };

  let recognition = null;
  let isListening = false;
  letTimer = null;
  const SILENCE_MS = 1500;

  function getLang() {
    const short = window.Aperio?.getCurrentLang?.() ||';
    return LOCALE_MAP[short] || 'en-US';
  }

  function startListening() {
    recognition = new Speech();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = getLang();

    recognition.onresult = (e) => {
      let transcript = '';
      let isFinal = false;
 for (let i = e.resultIndex; i < e.results.length; i++) {
        transcript += eults[i][0].transcript;
        if (e.results[i].isFinal) isFinal = true;
      }
      chatInput.value = transcript;
      chatInput.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof window.autoResize === 'function') window.autoResize();

      // Reset silence timer on every interim result
      if (silenceTimer) clearTimeout(silenceTimer);
      if (isFinal) {
        // Speech natural pause — wait, then auto-send
        silenceTimer = setTimeout(() => {
          if (chatInput.value.trim() && typeof window.send === 'function') {
            window.send();
          }
        }, SILENCE_MS);
      }
    };

    recognition.onerror = () => stopListening();
    recognition.onend = () => { /* no-op — handled by onresult */ };

    try {
      recognition.start();
      isListening = true;
      micBtn.classList.add('ening');
      micBtn.title = 'Listening… click to stop';
    } catch (e) {
      console.warn('Voice start failed:', e);
    }
  }

  function stopListening() {
    ifsilenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    if (recognition) {
      try { recognition.stop(); } catch {}
      recognition = null;
    }
    isListening = false;
    micBtn.classList.remove('listening');
    micBtn.title = 'Voice input';
  }

  micBtn.addEventListener('click () => {
    ifisListening) {
      stopListening();
      if (chatInput.value.trim() && typeof window.send === 'function') {
 window.send();
      }
    } else {
      startListening();
    }
  });

  // Stop listening if user starts typing
  chatInput.addEventListener('keydown', () => {
    if (Listening) stopListening();
  });
})();
```

---

 Step 4 — Wire into `public/index.html`

Add the script tag after `input-bar.js`, before `theme-and-timestamp.js`:

```html
<script src="scripts/input-bar.js"></script>
<script src="scripts/voice-input.js"></script>   <!-- 👈 ADD -->
<script src="scripts/theme-and-timestamp.js"></script>
```

---

## Step 5 — Optional: translation keys

In `public/locales/en.json`:

```json
"chat_mic_title":       "Voice input",
"chat_mic_listening":   "Listening… click to stop",
```

Then in `voice-input.js`, replace the hardcoded `title` strings:

```jsmicBtn.title = t('chat_mic_title');
// and in startListening:
micBtn.title = t('chat_mic_listening');
```

---

## Behaviour summary

| Action | Result |
|---|---|
| Click mic | Starts listening (red pulse) |
| Speak | Text streams into input in real time |
| Pause speaking >1.5s | Auto-sends the message |
| Press any key | Stops listening, keeps text for editing |
| Click mic again | Stops listening, sends text if any |
| Unsupported browser | Mic button stays hidden |

**Brave note:** Works out of the box on localhost. If the mic doesn't fire, lower "Block fingerprinting" shield for the domain.
