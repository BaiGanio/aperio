# Translation Strategy — 24 EU Languages

## Guiding Principles

- **Small batches** — never translate more than 3 languages at once
- **Quality first** — start with my strongest languages, validate, then expand
- **Incremental** — each batch is independently deployable. Languages overlap
  with English fallback for keys not yet translated
- **Human validation** — weaker languages get a manual pass from a native speaker
  before being marked "complete"

---

## Batch 1 — Setup & Validation (3 languages)

**Goal**: Test the pipeline. Validate the JSON format, verify the lang-switcher
works, confirm nothing breaks.

| Language | Code | My Confidence | Action |
|---|---|---|---|
| **German** | `de` | High — near-native | AI-only |
| **French** | `fr` | High — near-native | AI-only |
| **Spanish** | `es` | High — near-native | AI-only |

**Total**: ~360 keys (3 × 120)  
**Estimated tokens**: ~6,000–8,000  
**Output**: 3 JSON files ready to ship

---

## Batch 2 — Romance + Dutch (3 languages)

**Goal**: Cover the next most widely spoken EU languages.

| Language | Code | My Confidence | Action |
|---|---|---|---|
| **Italian** | `it` | High | AI-only |
| **Portuguese** | `pt` | High | AI-only |
| **Dutch** | `nl` | High | AI-only |

**Total**: ~360 keys  
**Keep in mind**: `pt` serves as base for potential Brazilian Portuguese variant
later (separate key `pt-BR` if needed)

---

## Batch 3 — Nordic (3 languages)

| Language | Code | My Confidence | Action |
|---|---|---|---|
| **Swedish** | `sv` | Good — grammatically correct | AI + quick human review |
| **Danish** | `da` | Good | AI + quick human review |
| **Finnish** | `fi` | Weaker — non-Indo-European | AI + native human review |

**Note**: Finnish is structurally very different. The AI version will get the
meaning across but likely sound "off" to a native speaker. Budget a full pass.

---

## Batch 4 — Slavic (4 languages)

| Language | Code | My Confidence | Action |
|---|---|---|---|
| **Polish** | `pl` | Good | AI + human review |
| **Czech** | `cs` | Good | AI + human review |
| **Slovak** | `sk` | Good | AI + human review |
| **Slovenian** | `sl` | Decent — shares features with Croatian | AI + human review |

**Slavic overlap**: These share grammar patterns. Translating them together helps
catch inconsistencies. Czech and Slovak are ~90% mutually intelligible — one
pass validates the other.

---

## Batch 5 — Balkan & Greek (3 languages)

| Language | Code | My Confidence | Action |
|---|---|---|---|
| **Croatian** | `hr` | Good | AI + human review |
| **Romanian** | `ro` | Good — Romance structure, Slavic loanwords | AI + human review |
| **Greek** | `el` | Weaker — different alphabet, limited data | Native human required |

**Keep in mind**: `hr` (Croatian) is nearly identical to Serbian, Bosnian,
Montenegrin at this UI-text level. One translation covers 4 markets.

---

## Batch 6 — Baltic (2 languages)

| Language | Code | My Confidence | Action |
|---|---|---|---|
| **Latvian** | `lv` | Weak — small training corpus | Native human required |
| **Lithuanian** | `lt` | Weak — small training corpus | Native human required |

**Note**: These are not mutually intelligible. Each needs a separate native pass.

---

## Batch 7 — Hungarian (1 language)

| Language | Code | My Confidence | Action |
|---|---|---|---|
| **Hungarian** | `hu` | Decent — agglutinative but I have enough data | AI + native review |

**Note**: Hungarian is structurally closer to Finnish than to any neighbouring
language. Worth a dedicated review from a native speaker — especially for
suffix-heavy phrases like `"Import {n} memories"`.

---

## Batch 8 — Small Nations (3 languages)

| Language | Code | My Confidence | Action |
|---|---|---|---|
| **Estonian** | `et` | Weak | Native human required |
| **Maltese** | `mt` | Very weak — Semitic structure, Italian loanwords, Latin script | Native human required |
| **Irish** | `ga` | Very weak — Celtic language, very limited data | Native human required |

**Note**: Maltese in particular is tricky — it's a Semitic language (derived
from Arabic) written in Latin script with heavy Italian/English loanwords. The
UI phrases here are short enough that a native speaker can knock out the 120
keys in under an hour.

---

## Summary Table

| Batch | Languages | Confidence | Total Keys | Human Required? |
|---|---|---|---|---|
| 1 | `de` `fr` `es` | High | ~360 | No |
| 2 | `it` `pt` `nl` | High | ~360 | No |
| 3 | `sv` `da` `fi` | Good–Weak | ~360 | fi: yes |
| 4 | `pl` `cs` `sk` `sl` | Good | ~480 | Recommended |
-- Needs audit
| 5 | `hr` `ro` `el` | Good–Weak | ~360 | el: yes |
| 6 | `lv` `lt` | Weak | ~240 | Yes |
| 7 | `hu` | Decent | ~120 | Recommended |
| 8 | `et` `mt` `ga` | Very weak | ~360 | Yes |

**Total**: ~2,640 keys across 8 batches.

---

## How to Process a Batch

1. I generate 1 JSON file per language in the batch
2. You review the JSONs (or forward them to a native speaker)
3. Once approved, place them in `public/locales/`
4. The app picks them up on next load — zero code changes needed

Each batch takes me about 2,000–4,000 tokens to produce. That's ~15–30 seconds
of generation and about 5–10 minutes of human review.

---

## Optional: Priority Override

If you want to focus on a specific market first, just tell me which languages
matter most *right now*. The batches above are ordered by my translation
confidence, not by market size. If Bulgarian devs who prefer French are your
primary audience, we swap batches accordingly.
