# Aperio i18n — Current State & Optimization Plan

## The Problem

**Currently**: 1 monolithic file (`public/scripts/i18n.js`, ~590 lines) containing:

- `en` — full translation (~120 keys)
- `bg` — full translation (~120 keys)
- 22 other EU languages — empty objects `{}` (fall back to English at lookup time)

**Scaling issues**:

- Every user downloads ALL 24 languages, regardless of which one they use
- Adding 1 key means editing 2 inline dictionaries at the same offset — error-prone
- Adding 1 new language means inserting 120 keys into the same file — merge conflicts guaranteed
- No separation between engine and data — makes maintenance harder

---

## Phase 1 — Split Files

### Directory structure

```
public/
  scripts/
    i18n.js              ← thin engine only (detection, t(), setLang(), applyTranslations())
  locales/
    en.json              ← English translations (only file bundled inline as fallback)
    bg.json              ← Bulgarian translations
    de.json              ← German translations
    ...
    ga.json              ← Irish translations
```

### `i18n.js` becomes thin

- Only the engine remains: `pickInitialLang()`, `t()`, `setLang()`, `getCurrentLang()`, `applyTranslations()`, `LOCALE_META`
- `TRANSLATIONS` contains only `en` — bundled inline as the **immediate fallback**
- On `setLang()` or initial boot: fetch `fetch(`/locales/${lang}.json`)`, then merge into memory and call `applyTranslations()`

### Loading sequence

1. `i18n.js` loads synchronously (as now) — English fallback is instant
2. Immediately after language detection → `fetch(`/locales/${lang}.json`)`
3. On success: merge into `TRANSLATIONS` → `applyTranslations()`
4. On failure (network, missing file): English fallback is already in memory — zero downtime

### Advantage

Each user downloads exactly 1 JSON chunk (~2-3 KB) + a small inline English fallback.

---

## Phase 2 — Tool for Adding Keys

Adding a key across all 24 languages becomes mechanical, not manual.

### Option A: Runtime helper

```js
function detectMissingKeys() {
  const en = TRANSLATIONS.en;
  for (const [lang, dict] of Object.entries(TRANSLATIONS)) {
    if (lang === "en") continue;
    for (const key of Object.keys(en)) {
      if (dict[key] === undefined) {
        console.warn(`Missing key "${key}" in locale "${lang}"`);
      }
    }
  }
}
```

### Option B: Shell script to add a key

```bash
# Usage: add-key.sh <key> <english_value>
# Example: add-key.sh nav_help "Help"
# This adds "nav_help": "Help" to all 24 locale JSON files

for file in public/locales/*.json; do
  # Use jq or similar to insert the key with a placeholder
  jq --arg k "$1" --arg v "$2" '. + {($k): $v}' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
done
```

One command → the new key exists in all 24 files. Translators just fill in the values.

---

## Phase 3 — Adding a New Language

```bash
cp public/locales/en.json public/locales/es.json
```

Then:
1. Add `es: { flag: "🇪🇸", name: "Español", englishName: "Spanish" }` to `LOCALE_META` in `i18n.js`
2. The language appears instantly in the lang-switcher dropdown
3. Translating the 120 keys is a separate task — the UI works fine without it (falls back to English via the bundled fallback)

---

## Summary — Before vs After

| Before | After (Phase 1) |
|---|---|
| 1 file ~590 lines | 1 file ~100 lines (engine) + 24 JSON files |
| Every user downloads all 24 languages | Every user downloads 1 JSON (~2-3 KB) |
| New key = careful inline edit | New key = 1 shell command |
| New language = edit 1 file + add 120 keys | New language = 1 shell command + translate |
| Merge conflicts in one fat file | Per-language JSON — no merge conflicts |
