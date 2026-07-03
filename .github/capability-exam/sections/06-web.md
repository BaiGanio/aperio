# §6 — Web & GitHub tools

`fetch_url` · `fetch_github_issue` · image tools

> Run per the loop in exam.md: announce, ask **"Run it? (yes / no)"**, act on yes, check
> against **✅ Expected**, checkpoint. Fetch `07-skills.md` when done.

### 6.1 fetch_url
`Fetch https://example.com and summarize what's on the page.`
✅ `fetch_url`; returns page text and a summary.

### 6.2 fetch_github_issue
`Summarize this GitHub issue, including the discussion: https://github.com/nodejs/node/issues/1`
✅ `fetch_github_issue`; returns title, state, body, and comments. (Needs network; a `GITHUB_TOKEN` raises rate limits.)

### 6.3 read_image / describe_image
For this drill, ask the user to attach an image in the UI, then run:
`Describe this image.`
✅ `read_image` / `describe_image` fires (the local VLM path may also trigger the `preprocess-image` skill — see §7). If no image can be attached, record this drill as skipped.
