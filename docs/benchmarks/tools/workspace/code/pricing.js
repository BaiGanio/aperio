// Benchmark fixture module for code-graph qualification cases.
// Small on purpose: the model-tier runner copies this tree into an isolated
// workspace and indexes it so code_search / code_context have a real symbol to
// find. Do not import this from application code.

export function applyDiscount(price, pct) {
  return price - price * pct;
}

export function computeQuote(lineItems, discountPct) {
  const subtotal = lineItems.reduce((sum, item) => sum + item.price * item.qty, 0);
  return applyDiscount(subtotal, discountPct);
}
