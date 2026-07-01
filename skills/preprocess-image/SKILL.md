---
name: preprocess-image
description: "Use this skill before sending any image to a local Ollama vision model (LLaVA, Qwen3-VL, Gemma 3, etc.). Triggers when: an image attachment arrives via the web UI, a file path points to a .jpg/.jpeg/.png/.gif/.webp, or a local VLM produces unexpected output on an image (wrong colors, errors, silent failures). This skill normalize the image to RGB PNG at 896×896 with a solid background fill — the format local VLMs expect. Do NOT use for images already confirmed to be plain RGB PNGs with no alpha channel, or when sending images to cloud APIs (Anthropic, OpenAI) that handle raw uploads natively."
compatibility: "Aperio MCP server — requires sharp (npm install sharp)"
---

# Image Preprocessing

## Why this skill exists

Local vision models (Ollama, llama.cpp) assume a specific input format:
RGB color space, no alpha channel, fixed square resolution. When the
input deviates — RGBA PNG, palette-mode GIF, CMYK JPEG, arbitrary
dimensions — the model either errors silently or produces wrong output.

This skill normalizes any image to that expected format before it reaches
the model.

## When to use `preprocess_image`

Use it when any of the following are true:

- The image came from a web UI upload (format is unknown)
- The file extension is `.png` (may have alpha / transparency)
- The file extension is `.gif` or `.webp` (commonly RGBA or animated)
- The local VLM previously produced garbled or empty output on this image
- You want consistent, predictable results regardless of source

You do NOT need it for:
- Images already confirmed as plain RGB JPEGs with no alpha
- Images being sent to cloud APIs (Anthropic, OpenAI handle raw uploads)

## Tool reference

### `preprocess_image`

Normalizes an image to RGB PNG at a fixed square size.

**Parameters**

| Parameter    | Type   | Default | Description |
|--------------|--------|---------|-------------|
| `path`       | string | —       | Absolute path to a local image file |
| `data`       | string | —       | Base64 image (raw or `data:image/...;base64,...` format) |
| `background` | enum   | `white` | Fill color for transparent areas and letterbox padding |
| `size`       | number | `896`   | Target square size in pixels |

Provide either `path` or `data` — not both.

**`background` values**

- `white` — for documents, diagrams, screenshots on light backgrounds
- `dark` — for UI screenshots on dark themes

**`size` guidance**

- `896` — default, works with all Ollama VLMs
- `512` — faster processing, lower detail; fine for classification tasks
- `1024` — higher detail; use for dense text in images, small labels, charts

**Returns**

A normalized `image/png` content block plus a confirmation text block.
The returned base64 can be passed directly to `read_image` or used in
an Ollama API call.

## Standard workflow

```
1. User uploads image (or agent receives a file path)
2. Call preprocess_image → get normalized PNG base64
3. Call read_image with the normalized data → agent sees the image
4. Proceed with analysis
```

## What the normalization does

Three operations happen in sequence, always in this order:

**1. Alpha removal**
Any transparency is composited onto the chosen background color.
This covers RGBA, palette-mode images with transparency, and
greyscale+alpha. Images without alpha are unaffected.

**2. Colour space conversion**
The image is converted to sRGB. This handles CMYK (common in
print-sourced PDFs), Lab, greyscale, and palette modes.

**3. Letterbox resize**
The image is scaled to fit inside `size × size` while preserving
its aspect ratio, then padded with the background color to reach
the exact target dimensions. The image is never stretched.

## Common cases

**Transparent PNG (logo, diagram, screenshot)**
```
preprocess_image(path: "/uploads/logo.png", background: "white")
```
White background fills the transparent areas before the model sees it.

**Dark-theme UI screenshot**
```
preprocess_image(path: "/uploads/screenshot.png", background: "dark")
```
Matching the background avoids a bright white halo around UI elements.

**Base64 from web UI upload**
```
preprocess_image(data: "<base64 string from att.data>", background: "white")
```
The data-URI header (`data:image/png;base64,`) is stripped automatically.

**High-detail image (dense text, chart labels)**
```
preprocess_image(path: "/uploads/chart.jpg", size: 1024)
```
Larger size preserves fine detail the model might miss at 896.

## Implementation

- `mcp/tools/image.js` — tool registration (`preprocess_image`)
- `mcp/assets/preprocessImage.js` — `preprocessImage()` and `preprocessBase64()`
- Dependency: `sharp` (`npm install sharp`)

The server-side attachment handler in `server.js` calls `preprocessBase64()`
directly on every image upload before it reaches the agent, so in most cases
the agent receives a pre-normalized image and does not need to call this tool
manually. Use this tool explicitly when:
- Working with image paths from `scan_project` or `read_file`
- Re-processing a previously uploaded image at a different size
- The automatic preprocessing at upload time was bypassed