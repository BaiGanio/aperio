// ─── Embeddings ───────────────────────────────────────────────────────────────

export async function generateEmbedding(text, inputType = "document") {
  const provider = (process.env.EMBEDDING_PROVIDER || "voyage").toLowerCase();

  if (provider === "ollama") {
    const model   = process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text";
    const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    try {
      const res  = await fetch(`${baseUrl}/api/embed`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ model, input: text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const vec  = data.embeddings?.[0] ?? data.embedding ?? null;
      if (!Array.isArray(vec) || vec.length === 0) {
        console.error("⚠️  Ollama returned unexpected embedding shape:", JSON.stringify(data).slice(0, 120));
        return null;
      }
      return vec;
    } catch (err) {
      console.error("⚠️  Ollama embedding failed:", err.message);
      return null;
    }
  }

  if (!process.env.VOYAGE_API_KEY) {
    console.error("⚠️  VOYAGE_API_KEY not set — skipping embedding");
    return null;
  }
  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.VOYAGE_API_KEY}` },
      body:    JSON.stringify({ model: "voyage-3", input: [text], input_type: inputType }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.data[0].embedding;
  } catch (err) {
    console.error("⚠️  Voyage embedding failed:", err.message);
    return null;
  }
}

export async function initEmbeddings(store, generateEmbeddingFn) {
  const { total, embedded: embCount } = await store.counts();
  console.error(`📊 Database Stats: ${total} total, ${embCount} embedded`);

  if (embCount === 0 && total > 0) {
    console.error(`✅ Vector store ready — ⚠️  no embeddings yet (${total} memories) — auto-backfilling silently…`);
    setImmediate(async () => {
      try {
        const pending = await store.listWithoutEmbeddings();
        let success = 0, failed = 0;
        for (const row of pending) {
          const embedding = await generateEmbeddingFn(`${row.title}. ${row.content}`);
          if (embedding) { await store.setEmbedding(row.id, embedding); success++; }
          else failed++;
        }
        console.error(`✅ Auto-backfill complete: ${success} embedded${failed ? `, ${failed} failed` : ""}.`);
      } catch (err) {
        console.error(`⚠️  Auto-backfill error: ${err.message}`);
      }
    });
  } else if (embCount === 0 && total === 0) {
    console.error(`✅ Vector store ready — no memories yet.`);
  } else {
    console.error(`✅ Vector store ready — semantic search active (${embCount}/${total} memories embedded)`);
  }
}