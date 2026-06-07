---
name: theme-factory
description: Toolkit for styling artifacts with a theme, and for creating distinctive, production-grade frontend interfaces. Use for: applying pre-set or custom themes to slides, docs, reports, HTML pages; building web components, pages, dashboards, React components, HTML/CSS layouts; or styling/beautifying any web UI with high design quality.
license: Complete terms in LICENSE.txt
metadata:
  keywords: "theme, style, design, frontend, web, html, css, react, component, landing page, dashboard, typography, color, palette, artifact, ui, interface"
  category: "design"
  load: "on-demand"
---


# Theme Factory Skill

This skill provides a curated collection of professional font and color themes themes, each with carefully selected color palettes and font pairings. Once a theme is chosen, it can be applied to any artifact.

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

The following 10 themes are available, each showcased in `theme-showcase.pdf`:

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

### Design Thinking

Before coding, commit to a clear aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick deliberately — brutally minimal, maximalist, retro-futuristic, organic, luxury, playful, editorial, brutalist, art deco, soft/pastel, industrial. Execute with intentionality, not randomness.
- **Differentiation**: What's the one thing someone will remember about this?

### Aesthetic Guidelines

- **Typography**: Avoid generic fonts (Arial, Inter, Roboto, system fonts). Choose distinctive display + refined body pairings that elevate the design.
- **Color**: Commit to a cohesive palette via CSS variables. Dominant colors with sharp accents outperform timid, evenly-distributed palettes. Avoid clichéd purple gradients on white.
- **Motion**: Use CSS animations for micro-interactions and page load reveals. One well-orchestrated entrance (staggered `animation-delay`) beats scattered effects. Add hover states that surprise.
- **Composition**: Asymmetry, overlap, diagonal flow, grid-breaking elements. Generous negative space OR controlled density — not both, not neither.
- **Backgrounds & Depth**: Gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, grain overlays — create atmosphere, don't default to solid fills.

**Never**: overused font families, purple-on-white gradients, predictable layouts, or cookie-cutter component patterns. No two designs should converge on the same aesthetic.

Match implementation complexity to vision: maximalist designs need elaborate animations; minimalist designs need precision in spacing and typography. Elegance comes from executing the chosen direction well, not from adding more.
