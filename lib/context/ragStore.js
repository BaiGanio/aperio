// In-memory RAG store for a single WebSocket session.
//
// When context is compressed (summarized), detailed message pairs are indexed
// here so they remain retrievable even after being removed from the live
// messages array. On each turn, relevant past exchanges are retrieved and
// injected into the system prompt so the model retains access to specific
// details that would otherwise be permanently lost.

function extractText(msg) {
  if (typeof msg.content === "string") return msg.content.trim();
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter(b => b.type === "text")
    .map(b => b.text || "")
    .join(" ")
    .trim();
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function createRagStore() {
  const chunks = []; // { text: string, embedding: number[] }

  return {
    // Index user+assistant pairs from `messages` before they are compressed.
    // Skips tool-only turns, very short exchanges, and already-indexed chunks.
    async index(messages, generateEmbedding) {
      for (let i = 1; i < messages.length - 1; i++) {
        const u = messages[i];
        const a = messages[i + 1];
        if (u.role !== "user" || a.role !== "assistant") continue;
        const uText = extractText(u);
        const aText = extractText(a);
        i++; // advance past the assistant message regardless
        if (!uText || !aText || uText.length + aText.length < 50) continue;
        const text = `User: ${uText}\nAssistant: ${aText}`;
        if (chunks.some(c => c.text === text)) continue; // deduplicate
        const embedding = await generateEmbedding(text, "document");
        if (embedding) chunks.push({ text, embedding });
      }
    },

    // Return top-K past exchanges most relevant to `query`.
    // Returns empty array when the store is empty or embedding fails.
    async retrieve(query, generateEmbedding, topK = 3) {
      if (chunks.length === 0) return [];
      const qEmb = await generateEmbedding(query, "query");
      if (!qEmb) return [];
      return chunks
        .map(c => ({ text: c.text, score: cosine(qEmb, c.embedding) }))
        .filter(c => c.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map(c => c.text);
    },

    get size() { return chunks.length; },
  };
}
