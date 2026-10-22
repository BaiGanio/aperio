---
name: theme-factory
description: Toolkit for styling artifacts with a theme, and for creating distinctive, production-grade frontend interfaces. Use for: applying pre-set or custom themes to slides, docs, reports, HTML pages; building web components, pages, dashboards, React components, HTML/CSS layouts; or styling/beautifying any web UI with high design quality. ALWAYS use this skill before building any frontend or UI — it prevents the default "clean SaaS with purple gradient" trap that makes every AI-built site look identical.
license: Complete terms in LICENSE.txt
metadata:
  keywords: "theme, style, design, frontend, web, html, css, react component, ui component, landing page, dashboard, typography, color palette, palette, artifact, ui, interface, aesthetic, movement, bauhaus, brutalism, art deco, html file, write html, create html, build html, web page, website"
  category: "design"
  load: "on-demand"
---


# Theme Factory Skill

This skill provides a curated collection of professional font and color themes, each with carefully selected color palettes and font pairings. Once a theme is chosen, it can be applied to any artifact.

**The most important thing this skill does**: break convergence. Every AI-built interface gravitates toward the same output — Inter font, rounded corners, purple-to-blue gradient, white background, soft shadows. This skill exists to prevent that. Each project must commit to a distinct aesthetic direction before any code is written.

## Purpose

To apply consistent, professional styling to presentation slide decks, use this skill. Each theme includes:
- A cohesive color palette with hex codes
- Complementary font pairings for headers and body text
- A distinct visual identity suitable for different contexts and audiences

## Usage Instructions

To apply styling to a slide deck or other artifact:

1. **Generate and show the swatch sheet**: Run `node skills/theme-factory/scripts/swatches.js swatches.png` from the project root. The tool result will contain a `/scratch/...` URL — use it directly in markdown to display the image inline: `![swatches](/scratch/.../swatches.png)`.
2. **Ask for their choice**: Ask which theme to apply to the deck
3. **Wait for selection**: Get explicit confirmation about the chosen theme
4. **Apply the theme**: Once a theme has been chosen, apply the selected theme's colors and fonts to the deck/artifact

## Themes Available

The following 10 pre-built themes are available, each showcased in `theme-showcase.pdf`:

1. **Ocean Depths** - Professional and calming maritime theme
2. **Sunset Boulevard** - Warm and vibrant sunset colors
3. **Forest Canopy** - Natural and grounded earth tones
4. **Modern Minimalist** - Clean and contemporary grayscale
5. **Golden Hour** - Rich and warm autumnal palette
6. **Arctic Frost** - Cool and crisp winter-inspired theme
7. **Desert Rose** - Soft and sophisticated dusty tones
8. **Tech Innovation** - Bold and modern tech aesthetic
9. **Botanical Garden** - Fresh and organic garden colors
10. **Midnight Galaxy** - Dramatic and cosmic deep tones

## Theme Details

Each theme is defined in the `themes/` directory with complete specifications including:
- Cohesive color palette with hex codes
- Complementary font pairings for headers and body text
- Distinct visual identity suitable for different contexts and audiences

## Application Process

After a preferred theme is selected:
1. Read the corresponding theme file from the `themes/` directory
2. Apply the specified colors and fonts consistently throughout the deck
3. Ensure proper contrast and readability
4. Maintain the theme's visual identity across all slides

## Create your Own Theme
To handle cases where none of the existing themes work for an artifact, create a custom theme. Based on provided inputs, generate a new theme similar to the ones above. Give the theme a similar name describing what the font/color combinations represent. Use any basic description provided to choose appropriate colors/fonts. After generating the theme, show it for review and verification. Following that, apply the theme as described above.

---

## Frontend Design Guidelines

When building web components, pages, or UI from scratch (rather than theming an existing artifact), apply these principles to produce distinctive, production-grade output.

### Step 0: Commit to an Aesthetic Direction (Non-Negotiable)

Before writing a single line of CSS, pick a movement from the catalog below and state it explicitly. This is not optional — skipping this step is how you end up with another generic SaaS landing page. The movement governs every subsequent decision: font choice, color palette, layout structure, motion, spacing.

If the user hasn't specified a direction, pick one that fits the content and audience. Use the prompt length, word choice, and subject matter as signals. A finance tool is not the same as a music app; a children's product is not the same as a developer tool.

### The Aesthetic Catalog

Pick ONE direction and execute it with conviction. Mixing two movements produces mush.

**Modernist / Geometric**
- **Bauhaus** (1919–1933): Geometric sans-serifs (try Futura or Bebas Neue), primary color triads, functional layout with bold typographic hierarchy. No decoration that doesn't serve function. Think Gropius posters.
- **De Stijl / Neoplasticism**: Mondrian-grid layouts, only black/white/red/yellow/blue, thick black rules as dividers, Helvetica or geometric sans. Radical grid rigidity.
- **Swiss International Style**: Strict column grids, Helvetica or Akzidenz-Grotesk, black and one accent color max, flush-left ragged-right type, documentary photography. Clean but cold.
- **Russian Constructivism** (1920s): Diagonal rules, bold reds and blacks, photomontage-style image placement, condensed grotesque type. Urgency and dynamism.

**Ornamental / Historical**
- **Art Nouveau** (1890s–1910s): Flowing organic curves, botanical motifs, peacock/forest color palettes (deep teals, golds, burgundy), decorative letterforms (try Playfair Display or a display serif with swashes). Nature as structure.
- **Art Deco** (1920s–1930s): Geometric ornament, symmetry, gold/black/ivory or teal/gold, stepped forms, luxury serifs. Glamour through precision.
- **Victorian/Maximalist**: Layer upon layer — borders within borders, ornate serif type, deep jewel tones (emerald, ruby, sapphire), flourishes, dense texture. Controlled excess.

**Editorial / Print**
- **Brutalist Editorial** (Bloomberg Businessweek style): Chaotic-feeling but intentional, strong typographic contrasts, unexpected color drops on headlines, playful illustration alongside hard facts. The layout surprises you.
- **Luxury Editorial** (Vogue/Harper's Bazaar): Full-bleed imagery, elegant serif display type (Bodoni, Didot), extreme whitespace, whisper-quiet body text, gold or stark black accents. Less is always more.
- **Dark Academia**: Rich mahogany/forest-green/ivory palette, classic serif type, paper textures, candlelight warmth. Scholarly and atmospheric.
- **Zine / Post-Punk**: Cut-and-paste collage, photocopied texture, deliberately clashing type sizes, hand-drawn elements, black and one neon. Anti-polish as aesthetic.

**Digital Movements**
- **Brutalist Web**: Raw structure, system fonts or monospace, visible borders everywhere, no rounding, no shadows, high contrast. HTML as material, not disguised. Think brutalistwebsites.com.
- **Neumorphism**: Soft extruded surfaces, monochromatic with tight value range, embossed elements, no hard edges. Light and shadow as the only visual language. Use sparingly — works best for dashboards.
- **Glassmorphism**: Frosted translucent panels, blurred background, thin white borders, vibrant background behind the glass. Works on gradient or image backgrounds only.
- **Claymorphism**: 3D inflated shapes, saturated pastels, thick soft shadows with color, rounded to the extreme. Playful and tactile.
- **Retro Computing / DOS Aesthetic**: CGA or EGA 16-color palette, pixel/bitmap fonts (e.g., Press Start 2P), scanline texture, terminal green-on-black or amber-on-black, no anti-aliasing.
- **Y2K / Cyber**: Holographic chrome gradients, translucent plastics, bubble typography, electric blue and silver, grid overlays. Early-internet optimism turned maximalist.

**Subcultural / Era**
- **Memphis Group** (1980s): Bold clashing colors (hot pink, electric yellow, cobalt, black), geometric patterns as backgrounds (squiggles, dots, checkers), irreverent mismatched type. Postmodern fun, zero restraint.
- **Psychedelic / 1960s**: Distorted letterforms, extreme high-contrast complementary pairs, hand-drawn optical illusion patterns, swirling gradients. Experience over legibility — but readable enough.
- **Vaporwave**: Magenta/cyan/purple palette, retrofuturist Roman statues and grids, glitch text, Japanese characters as decoration, neon on dark. Nostalgia for a past that never existed.
- **Retrowave / Synthwave**: Dark background, sunset purple-orange-pink horizon gradient, geometric grid receding to vanishing point, neon glow text, 80s chrome letterforms.
- **Grunge Typography** (1990s Emigre era): Layered overlapping type, dirty textures, deliberately broken grids, photocopied distortion. Order that has been deliberately attacked.

**Nature / Atmosphere**
- **Japanese Minimalism / Wabi-sabi**: Near-total negative space, paper/linen texture, ink-like brushstroke accents, muted naturals (stone, moss, rice, rust), sparse haiku-like type. Incompleteness as beauty.
- **Scandinavian / Hygge**: Functional, warm off-whites, natural wood-toned palette, clean humanist sans, gentle curves. Comfort and clarity equally weighted.
- **Cottagecore**: Botanical illustration style, vintage pastels (dusty rose, sage, cream), hand-lettered or old-style serif, floral and organic motifs. Nostalgic and gentle.
- **Biophilic / Organic**: Curved asymmetric layouts, earthy pigments (terracotta, ochre, forest), leaf and stone textures, flowing line as UI element. Nature as grid.

**Dark / Dramatic**
- **Cyberpunk / Tech Noir**: Near-black backgrounds, neon magenta and electric cyan accents, rain/scan-line overlays, condensed technical type. Dystopia as aesthetic.
- **Neon Noir**: Film-noir composition (dramatic shadow, high contrast), neon color pops against dark, cinematic photography framing, smoky atmosphere. Moody and cinematic.
- **Gothic / Dark Romantic**: Deep blacks and crimsons, ornate serif or blackletter type, candle/moonlight as metaphor for light, filigree ornament. Dramatic and textural.

**Conceptual / Avant-Garde**
- **Dadaism**: Anti-compositional collage, random type rotation, cut-up word arrangements, black and red ink aesthetic, deliberate absurdity. Design as provocation.
- **Deconstructivist**: Overlapping layers, visible grid lines as decoration, type running vertically and at odd angles, fragmented composition. The process shown as product.
- **Scientific / Diagrammatic**: Technical drafting aesthetics, blueprint blue or laboratory white, monospace type, data visualization as decoration, measurement callouts. Rigor as beauty.

### Banned Defaults

The following are **banned** unless the user explicitly requests them. They represent the convergence trap:

- **Fonts**: Inter, Roboto, Open Sans, Lato, Nunito, Poppins (as the primary display font), generic system-ui
- **Palettes**: Purple-to-blue gradient on white background, "hero gradient" that goes indigo → violet → pink, all-gray on white with one blue accent
- **Layouts**: Centered hero with large H1 + subtext + CTA button, three-column feature cards with icons, footer with four link columns
- **Components**: Glassmorphism cards on a purple gradient (cliché combination), soft-shadow rounded cards on white, standard navbar with logo-left links-right
- **Motion**: Fade-in on scroll for every section equally, floating card hover lift effect on every card

If you find yourself reaching for any of the above, stop and interrogate why. Pick a different direction.

### Typography Rules

- Pick a **display font** that carries the movement's character. It should be distinctive at large sizes.
- Pick a **body font** that complements it — usually higher x-height and more neutral, but still on-movement.
- Load them from Google Fonts, Adobe Fonts CDN, or define @font-face from a web-safe CDN. Never use the system stack as a creative choice.
- Use **type scale contrast** — a ratio of at least 3:1 between your largest and second-largest type size. Flat hierarchies are unreadable.
- Suggested pairings by movement direction:
  - Geometric/Modernist: Futura + Source Serif 4, or Neue Haas Grotesk + Freight Text
  - Editorial/Luxury: Cormorant Garamond + Jost, or Bodoni Moda + DM Sans
  - Dark/Dramatic: Playfair Display + IBM Plex Mono, or Abril Fatface + Source Sans 3
  - Retro/Digital: Space Grotesk + Courier Prime, or VT323 + Inconsolata
  - Organic/Nature: Fraunces + Libre Baskerville, or Lora + Raleway

### Color Rules

- Define your palette in CSS custom properties (`--color-*`) before anything else.
- **Dominant** color: used for backgrounds and large surfaces (60% of visual weight)
- **Secondary** color: structural elements, mid-weight UI (30%)
- **Accent** color: CTAs, highlights, single punchy element (10%) — one is enough
- Avoid even distribution. A palette where every color appears equally often looks chaotic or flat.
- Derive tints and shades from your base hues algorithmically (HSL lightness steps) rather than picking unrelated colors for hover states.

### Layout & Composition Rules

- **Choose a layout energy**: rigid grid vs. asymmetric organic vs. editorial chaos. Don't default.
- Asymmetry, diagonal flow, overlapping elements, and grid-breaking are tools — use at least one.
- Generous negative space OR controlled density — not the tepid middle.
- Every layout decision should trace back to the chosen movement. Bauhaus demands the grid; Memphis demands the collision.

### Motion Rules

- One well-orchestrated entrance animation beats scattered effects on every element.
- Use `animation-delay` staggers for list items and cards.
- CSS-only animations preferred (no libraries for simple transitions).
- Hover states should surprise — not just `opacity: 0.8` or `translateY(-2px)`.
- Dark/dramatic movements: use motion sparingly, let stillness do work.
- Playful movements: motion can be more elaborate, even silly.

### The Anti-Convergence Check

Before delivering any frontend output, run through this list:

1. Can you name the aesthetic movement this design belongs to?
2. Would a designer who specializes in that movement recognize it?
3. Does it use a font not in the banned list?
4. Does the color palette avoid the banned patterns?
5. Is the layout doing something other than "centered hero + cards"?

If any answer is no, revise before delivering.

Match implementation complexity to vision: maximalist designs need elaborate animations; minimalist designs need precision in spacing and typography. Elegance comes from executing the chosen direction well, not from adding more.
