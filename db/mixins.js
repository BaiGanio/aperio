// db/mixins.js
// Shared mixin composition for the two store classes (S3.2, aperio-reset).
//
// db/sqlite/store.js and db/postgres/store.js had grown to 1589 and 1395 lines
// by carrying nine clearly-named, clearly-parallel responsibilities each — data
// portability, vec_meta bookkeeping, self-memories, agent jobs, durable
// interrupts, the issue-triage ledger, and so on. Those responsibilities are
// cohesive and testable on their own (tests/integration/db/contract/ already
// runs one test body per domain against BOTH backends), so each now lives in
// its own module under db/sqlite/ and db/postgres/.
//
// Why a mixin factory and not plain function modules taking `store`:
// db/index.js is a FACTORY — callers get one store object and call methods on
// it. Every extracted method had to keep its exact name on the prototype or
// the split would be a public-surface change, which
// tests/unit/db/store-surface-parity.test.js now fails on. Wrapping each
// domain as `(Base) => class extends Base { ... }` lets the method bodies move
// VERBATIM: no `this` rewriting, no delegating stubs, no object-literal commas
// to get wrong. The transform is a cut and paste, which is the only kind of
// refactor worth doing to code this load-bearing.
//
// The mixins are applied in the listed order, so a later mixin could override
// an earlier one's method. None currently do, and none should: these domains
// are disjoint by design. Keep them that way.

/**
 * Builds a base class carrying every mixin's methods.
 * @param {...((Base: Function) => Function)} mixins
 * @returns {Function} a class to `extends`
 */
export function composeStore(...mixins) {
  return mixins.reduce((Base, mixin) => mixin(Base), class {});
}
