---
name: design-randomizer
description: Generate a randomized design brief before any frontend or UI work to prevent aesthetic convergence. Use this skill whenever starting a new website, UI component, dashboard, landing page, or any visual design — especially when the user hasn't specified a visual style. It rolls a design brief (movement, palette, typography, layout, energy) that becomes the binding constraint for the whole build. Also use when the user says designs "always look the same", wants something "unique", "different", or "not like typical AI sites".
metadata:
  keywords: "random design, unique design, design brief, aesthetic, style, varied, different, not generic, fresh, original, design direction, frontend style, ui style, html file, write html, create html, build html, web page, website"
  category: "design"
  load: "on-demand"
---

# Design Randomizer

AI-built interfaces converge. Given no constraints, every model reaches for the same defaults: Inter font, rounded cards, purple-to-blue gradient, white background, fade-in animations. The result is a web where everything looks like it came from the same factory.

This skill breaks that convergence by generating a binding design brief before any work starts. The brief is derived from the user's prompt — not truly random, but diversified enough that different prompts produce meaningfully different aesthetics.

## How to Use This Skill

1. **Read the user's prompt** and extract signal: subject matter, audience, tone words, industry, any visual references mentioned.
2. **Select a design profile** from the catalog below — one that fits the signal. If the signal is ambiguous, pick the least expected option that still makes sense. Default to the surprising choice over the obvious one.
3. **State the brief** to the user in 3–5 lines before writing any code. This is a commitment, not a suggestion.
4. **Hand off to theme-factory** or proceed directly to implementation — but every decision must now be evaluated against the brief.

The brief is a constraint, not a suggestion. If implementation tempts you to reach for a banned default, the brief wins.

---

## How to Select a Profile

Use the user's prompt as a seed. Map it to one of these signals:

| Signal in prompt | Lean toward |
|---|---|
| Finance, legal, enterprise, B2B | Swiss International Style, Dark Academia, Diagrammatic |
| Music, culture, nightlife, events | Neon Noir, Retrowave, Vaporwave, Psychedelic |
| Food, wellness, nature, slow living | Cottagecore, Japanese Minimalism, Biophilic, Scandinavian |
| Tech product, developer tool, SaaS | Brutalist Web, Retro Computing, Constructivist, De Stijl |
| Fashion, luxury, editorial | Art Deco, Luxury Editorial, Art Nouveau |
| Children, playful, games, fun | Memphis Group, Claymorphism, Y2K, Psychedelic |
| Portfolio, creative agency | Brutalist Editorial, Dadaism, Deconstructivist, Grunge |
| Startup, general product, no signal | **Pick anything NOT in the banned defaults. Avoid "Tech Innovation" energy.** |

When in doubt, let the subject matter's emotional register guide you: calm vs. urgent, warm vs. cold, historical vs. futuristic, loud vs. quiet.

---

## The Brief Format

State the brief like this before writing any code:

```
Design Brief: [Movement Name]
─────────────────────────────
Movement:   [Name + 1-sentence character description]
Palette:    [2–3 colors with hex codes, named by role: dominant / secondary / accent]
Type:       [Display font] + [Body font] — [why this pairing fits the movement]
Layout:     [Layout energy: grid rigidity / editorial chaos / organic flow / etc.]
Signature:  [One distinctive element that makes this unmistakably this movement]
```

Example:

```
Design Brief: Russian Constructivism
─────────────────────────────────────
Movement:   Soviet avant-garde — urgency, geometry, dynamism. Design as manifesto.
Palette:    #CC0000 (dominant) / #111111 (secondary) / #F5F0E8 (accent/paper)
Type:       Oswald Condensed + IBM Plex Mono — industrial weight meets precision
Layout:     Diagonal rules, asymmetric grid, type at 15° angles, bold horizontal bands
Signature:  A thick red diagonal band cutting across the hero at 20deg
```

---

## The Movement Catalog

### Modernist / Geometric
- **Bauhaus**: Geometric sans, primary triad (red/yellow/blue/black), functional layout, no decoration without function. Fonts: Futura, Bebas Neue.
- **De Stijl**: Mondrian grid, only black/white/red/yellow/blue, thick black rules, radical rigidity. Fonts: Helvetica, Neue Haas.
- **Swiss International Style**: Column grids, Helvetica or Akzidenz-Grotesk, black + one accent, flush-left type, editorial photography.
- **Russian Constructivism**: Diagonal rules, bold reds and blacks, photomontage framing, condensed grotesque type. Urgency.

### Ornamental / Historical
- **Art Nouveau**: Organic curves, botanical motifs, deep teals/golds/burgundy, decorative letterforms. Fonts: Playfair Display, display serifs with swashes.
- **Art Deco**: Geometric ornament, symmetry, gold/black/ivory or teal/gold, stepped forms, luxury serifs.
- **Victorian Maximalism**: Layer upon layer, ornate serif type, jewel tones (emerald/ruby/sapphire), flourishes, dense texture.

### Editorial / Print
- **Brutalist Editorial**: Chaotic-feeling but intentional, strong typographic contrasts, unexpected color drops, playful illustration. Bloomberg Businessweek energy.
- **Luxury Editorial**: Full-bleed imagery, Bodoni or Didot display, extreme whitespace, whisper-quiet body. Less is always more.
- **Dark Academia**: Mahogany/forest-green/ivory, classic serif, paper texture, scholarly warmth.
- **Zine / Post-Punk**: Cut-and-paste collage, photocopied texture, clashing type sizes, hand-drawn elements, black + one neon.

### Digital Movements
- **Brutalist Web**: Raw structure, monospace or system fonts, visible borders, no rounding, no shadows, high contrast. HTML as material.
- **Neumorphism**: Soft extruded surfaces, monochromatic tight range, embossed elements, light/shadow as only language. Best for dashboards.
- **Glassmorphism**: Frosted translucent panels, blurred background, thin white borders, vibrant gradient behind glass.
- **Claymorphism**: Inflated 3D shapes, saturated pastels, thick colored shadows, extreme rounding.
- **Retro Computing**: CGA/EGA palette, pixel fonts (Press Start 2P, VT323), scanline texture, terminal green-on-black.
- **Y2K / Cyber**: Holographic chrome, translucent plastics, bubble type, electric blue and silver, grid overlays.

### Subcultural / Era
- **Memphis Group**: Bold clashing colors (hot pink/electric yellow/cobalt), geometric patterns as background, irreverent mismatched type.
- **Psychedelic / 1960s**: Distorted letterforms, extreme complementary color pairs, optical illusion patterns, swirling gradients.
- **Vaporwave**: Magenta/cyan/purple, retrofuturist imagery, glitch text, Japanese characters as decoration, neon on dark.
- **Retrowave / Synthwave**: Dark background, sunset purple-orange-pink gradient, geometric grid receding to horizon, neon glow text.
- **Grunge Typography**: Layered overlapping type, dirty textures, broken grids, photocopied distortion. Emigre magazine energy.

### Nature / Atmosphere
- **Japanese Minimalism / Wabi-sabi**: Near-total negative space, paper/linen texture, muted naturals (stone/moss/rice/rust), sparse type.
- **Scandinavian / Hygge**: Functional, warm off-whites, natural wood palette, gentle curves, clarity and comfort.
- **Cottagecore**: Botanical illustration, vintage pastels (dusty rose/sage/cream), hand-lettered or old-style serif, floral motifs.
- **Biophilic / Organic**: Curved asymmetric layouts, earthy pigments (terracotta/ochre/forest), flowing line as UI element.

### Dark / Dramatic
- **Cyberpunk / Tech Noir**: Near-black backgrounds, neon magenta and electric cyan, scan-line overlays, condensed technical type.
- **Neon Noir**: Film-noir composition, neon color pops against dark, cinematic photography framing, smoky atmosphere.
- **Gothic / Dark Romantic**: Deep blacks and crimsons, ornate serif or blackletter, filigree ornament, dramatic contrast.

### Conceptual / Avant-Garde
- **Dadaism**: Anti-compositional collage, random type rotation, cut-up word arrangements, black and red ink, deliberate absurdity.
- **Deconstructivist**: Overlapping layers, visible grid lines as decoration, type at odd angles, fragmented composition. The process as product.
- **Scientific / Diagrammatic**: Technical drafting aesthetic, blueprint blue or laboratory white, monospace type, data visualization as decoration, measurement callouts.

---

## Banned Defaults (Never Pick These Unprompted)

These are the convergence trap. If the brief resolves to any of these, pick again:

- Fonts: Inter, Roboto, Open Sans, Poppins (as display font), system-ui as a creative choice
- Palettes: purple-to-blue gradient on white, indigo→violet→pink hero, all-gray + single blue accent
- Layouts: centered hero + subtext + CTA button, three-column feature cards with icons, standard navbar logo-left links-right
- Effects: fade-in on scroll for every element, floating hover lift on every card, glassmorphism cards on a purple gradient

---

## After the Brief

Once the brief is stated and agreed (or accepted without objection), proceed with implementation under these rules:

1. Every font choice must be from or consistent with the brief.
2. Every color must come from the brief's palette (plus computed tints/shades).
3. Every layout decision must trace back to the movement's character.
4. Before delivering, run the anti-convergence check: name the movement, name the font, name the palette rule. If any answer is "I defaulted," revise.

The brief is a creative contract. Honor it.

---

## Delivering the Build

A "build" request means produce the working page **now, in this same response** — not a promise to build it next.

1. **Output the page directly — do NOT use tools to create it.** Put the complete document in a single fenced ` ```html ` code block in your reply. **Do NOT call `run_node_script`, `run_python_script`, `write_file`, or write a generator script** to produce the page — those repeatedly fail for this and waste the turn. Aperio automatically saves the ` ```html ` block to the workspace as a real file and shows a **Preview** / **Download** card. The code block IS the delivery mechanism.
2. **Do not announce and stop.** Never end a turn with "I will now generate the file" or "a .html file will be created" without the page itself in the same message. State the brief, then immediately output the code block.
3. **Unless the user names a framework (React, Vue, Next.js, etc.), deliver one self-contained `.html` file** — all CSS in a `<style>` block, any JS in a `<script>` block, no build step, no npm, no CDN beyond web fonts. It must work by opening the file directly in a browser.
4. **The HTML must be valid.** Include `<!DOCTYPE html>`, `<meta charset="utf-8">`, a `<title>`, and properly closed tags. CSS rule blocks use `{ … }`, not `:root;`. Custom properties use two hyphens (`--bg`), not an em-dash. A page that renders blank is a failed delivery — sanity-check the markup.
5. **Keep prose short:** name the movement/palette/type in 2–3 lines, then the code block. The user previews or downloads from the card.
