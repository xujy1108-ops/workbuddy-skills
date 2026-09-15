---
name: html-chart-renderer
description: Use HTML/CSS + Chrome screenshot to produce professional-looking data visualization images when the user asks to redraw, restyle, or beautify charts/infographics. Preferred over Pillow/Matplotlib for aesthetic quality, and more reliable than pure AI image generation for accurate Chinese text and data.
agent_created: true
---

# HTML Chart Renderer

## Overview

Render data visualizations as high-quality PNG images using HTML/CSS styling and a headless Chrome screenshot. This approach produces professional, modern-looking charts (gradients, shadows, glassmorphism, rounded corners, precise typography) while keeping all text, numbers, and data exactly correct.

Use this skill when the user:
- Asks to "redraw", "restyle", "换个样式", or "make this chart look better"
- Complains that code-drawn charts (Pillow, Matplotlib) look ugly or unprofessional
- Wants a chart/infographic output that matches a corporate/business design style

## Why This Approach

| Approach | Pros | Cons |
|---|---|---|
| Pillow/Matplotlib | Deterministic, text accurate | Ugly typography, flat colors, limited styling |
| Pure AI image generation (ImageGen) | Beautiful, artistic | Chinese text and numbers often garbled or wrong; data accuracy not guaranteed |
| HTML/CSS + Chrome screenshot | Professional visuals + accurate text/data | Requires writing HTML/CSS |

For business data visualizations, HTML/CSS + screenshot is the best balance of quality and accuracy.

## Workflow

### Step 1: Understand the Source

Read the original image or screenshot carefully. Extract:
- Title and subtitle text
- All data values, categories, and labels
- Chart type (bar, line, combo, cards, etc.)
- Color scheme and visual style
- Any annotations, growth rates, or callout cards
- Watermarks or brand marks

Do not guess data. Preserve the original text and numbers exactly.

### Step 2: Design the HTML/CSS

Create a single self-contained HTML file with inline CSS:

- Use a modern business palette:
  - Primary blue: `#2B7FFF` to `#1A6DE0` gradient
  - Accent orange: `#FF7A2E`
  - Background: light blue gradient (`#E8F1FF` → `#F5F9FF`)
  - Text dark: `#0B2A5C`
  - Text body: `#3A5278`
- Use `border-radius`, `box-shadow`, `backdrop-filter: blur()` for glassmorphism cards
- Use CSS gradients on bars instead of flat colors
- Use system Chinese fonts: `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`
- Add a subtle diagonal watermark using SVG pattern background if the original has one
- Keep layout responsive within a fixed-size container (e.g., 1600×820px)

### Step 3: Screenshot with Chrome

Use the bundled `scripts/screenshot.js` to render the HTML to a PNG:

```bash
node scripts/screenshot.js <input.html> <output.png> [width] [height]
```

Requirements:
- Google Chrome must be installed at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (macOS)
- `puppeteer-core` must be installed in the node workspace

If puppeteer-core is missing, install it:

```bash
cd /Users/dzsb-002295/.workbuddy/binaries/node/workspace
/Users/dzsb-002295/.workbuddy/binaries/node/versions/22.22.2/bin/npm install puppeteer-core
```

Run with the managed node runtime:

```bash
NODE_PATH=/Users/dzsb-002295/.workbuddy/binaries/node/workspace/node_modules \
/Users/dzsb-002295/.workbuddy/binaries/node/versions/22.22.2/bin/node \
scripts/screenshot.js input.html output.png 1600 820
```

### Step 4: Validate and Iterate

- Open the generated PNG and compare to the original
- Verify all text, numbers, and labels are correct
- Check for cutoff labels, overlapping elements, or alignment issues
- If needed, adjust HTML/CSS and re-screenshot

## Common Pitfalls

- **Label cutoff**: Leave enough headroom above the tallest bar/element for top labels and growth arrows
- **Font fallback**: Always provide Chinese font fallbacks
- **Watermark too strong**: Keep opacity low (0.04–0.08) so it does not distract
- **Flat colors**: Use gradients and shadows to avoid the "Pillow look"
- **Inconsistent spacing**: Use a consistent grid and padding system

## Assets

- `assets/chart-template.html` — starter template with the standard business chart container, color variables, and glassmorphism card styles

## Scripts

- `scripts/screenshot.js` — headless Chrome screenshot utility
