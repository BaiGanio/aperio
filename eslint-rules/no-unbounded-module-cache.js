/**
 * AP6 — a module-level cache with no size limit grows until the process dies.
 *
 * A module-level `new Map()` / `new Set()` that is mutated anywhere in the file
 * is a cache. Every cache must come from the one shared `boundedMap(max)`
 * helper. A frozen lookup table that is built once and never mutated is fine.
 */

const MUTATORS = new Set(['set', 'add', 'delete', 'clear', 'push', 'unshift']);
const CACHE_CTORS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'AP6: forbid a mutated module-level Map/Set cache that does not come from boundedMap()',
    },
    schema: [],
    messages: {
      unbounded:
        'AP6: module-level cache "{{name}}" has no size limit. Use the shared boundedMap(max) helper.',
    },
  },
  create(context) {
    /** @type {Map<string, any>} candidates */
    const candidates = new Map();
    /** @type {Set<string>} mutated */
    const mutated = new Set();

    return {
      'Program > VariableDeclaration > VariableDeclarator'(node) {
        if (node.id.type !== 'Identifier') return;
        const init = node.init;
        if (!init || init.type !== 'NewExpression') return;
        if (init.callee.type !== 'Identifier') return;
        if (!CACHE_CTORS.has(init.callee.name)) return;
        candidates.set(node.id.name, node);
      },
      MemberExpression(node) {
        if (node.object.type !== 'Identifier') return;
        if (node.property.type !== 'Identifier') return;
        if (!MUTATORS.has(node.property.name)) return;
        mutated.add(node.object.name);
      },
      'Program:exit'() {
        for (const [name, node] of candidates) {
          if (!mutated.has(name)) continue;
          context.report({ node, messageId: 'unbounded', data: { name } });
        }
        candidates.clear();
        mutated.clear();
      },
    };
  },
};

export default rule;
