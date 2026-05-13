import logger from "./logger.js";

const OLLAMA_VLM_MODEL = process.env.OLLAMA_VLM_MODEL || "qwen2.5vl:7b";

/**
 * Bridge images to text via a local Ollama VLM.
 *
 * Iterates all user messages, finds raw image blocks, and replaces each
 * with a text description obtained from the local VLM via `describe_image`.
 * Mutates `messages` in-place so downstream code only sees text.
 *
 * Falls back gracefully: if the VLM call fails, the existing `[Image: …]`
 * label remains so the model at least knows an image was present.
 *
 * @param {Array}  messages  - message array (mutated in-place)
 * @param {Function} callTool - MCP tool caller (signature: (name, input) => result)
 * @param {object}  emitter  - emitter for progress tokens
 */
export async function bridgeImagesToVLM(messages, callTool, emitter) {
  let described = 0;

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    if (msg.role !== "user") continue; // only bridge user-uploaded images

    const imageBlocks = msg.content.filter(b => b.type === "image" && b.source?.data);
    if (imageBlocks.length === 0) continue;

    const nonImageBlocks = msg.content.filter(b => b.type !== "image");

    for (let i = 0; i < imageBlocks.length; i++) {
      const img = imageBlocks[i];
      // Try to pick up the existing text label e.g. "[Image: filename.png]"
      const labelBlock = nonImageBlocks.find(b => b.type === "text" && /^\[Image:/.test(b.text));
      const imageLabel = labelBlock?.text || `Image ${i + 1}`;

      try {
        emitter.send({ type: "token", text: `> 🖼️ ${imageLabel} — describing with local VLM (${OLLAMA_VLM_MODEL})\n` });
        const desc = await callTool("describe_image", { data: img.source.data });

        if (desc && typeof desc === "string" && desc.trim()) {
          // Emit the full VLM output so the user can see what goes to the main model
          const quotedDesc = desc.trimEnd().replace(/\n/g, "\n> ");
          emitter.send({ type: "token", text: `> \n> ${quotedDesc}\n\n` });
          logger.info(`[VLM] ${OLLAMA_VLM_MODEL} → "${imageLabel}":\n${desc}`);

          // Remove the old label block; we'll add a richer one
          if (labelBlock) {
            const idx = nonImageBlocks.indexOf(labelBlock);
            if (idx !== -1) nonImageBlocks.splice(idx, 1);
          }
          nonImageBlocks.push({
            type: "text",
            text: `[Image: ${imageLabel} — described by local VLM (${OLLAMA_VLM_MODEL})]\n${desc}`,
          });
          described++;
        }
      } catch (err) {
        logger.warn(`[agent] bridgeImagesToVLM failed for "${imageLabel}": ${err.message}`);
        // Leave the existing [Image: …] label intact
      }
    }

    // Mutate in-place: replace image-heavy content with text-only version
    msg.content = nonImageBlocks.length
      ? nonImageBlocks
      : [{ type: "text", text: "[Image attached]" }];
  }

  if (described > 0) {
    logger.info(`[agent] bridged ${described} image(s) through local VLM (${OLLAMA_VLM_MODEL})`);
  }
}
