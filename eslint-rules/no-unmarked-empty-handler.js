/**
 * AP5 — an empty `catch {}` or `.catch(() => {})` hides errors.
 *
 * A logic path must log or rethrow. A cleanup path is allowed to swallow the
 * error, but it must say so with a `// cleanup` marker on or next to the line.
 */

const MARKER = /\bcleanup\b/i;

/** @param {{value: string}} comment */
function isCleanupMarker(comment) {
  return MARKER.test(comment.value);
}

/**
 * True when a `// cleanup` comment sits on, just above, or just after the node.
 * @param {import('eslint').Rule.RuleContext} context
 * @param {any} node
 */
function hasCleanupMarker(context, node) {
  const sourceCode = context.sourceCode;
  const all = sourceCode.getAllComments();
  const first = node.loc.start.line;
  const last = node.loc.end.line;
  return all.some((comment) => {
    if (!isCleanupMarker(comment)) return false;
    const line = comment.loc.start.line;
    return line >= first - 1 && line <= last + 1;
  });
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'AP5: forbid an empty catch block or empty .catch() handler unless it is marked // cleanup',
    },
    schema: [],
    messages: {
      emptyCatchBlock:
        'AP5: empty catch block hides the error. Log it, rethrow it, or mark the line `// cleanup`.',
      emptyCatchHandler:
        'AP5: empty .catch() handler hides the error. Log it, rethrow it, or mark the line `// cleanup`.',
    },
  },
  create(context) {
    /** @param {any} body */
    const isEmptyBody = (body) =>
      body && body.type === 'BlockStatement' && body.body.length === 0;

    return {
      CatchClause(node) {
        if (!isEmptyBody(node.body)) return;
        if (hasCleanupMarker(context, node)) return;
        context.report({ node, messageId: 'emptyCatchBlock' });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression') return;
        if (callee.property.type !== 'Identifier') return;
        if (callee.property.name !== 'catch') return;
        const handler = node.arguments[0];
        if (!handler) return;
        const isFn =
          handler.type === 'ArrowFunctionExpression' ||
          handler.type === 'FunctionExpression';
        if (!isFn) return;
        if (!isEmptyBody(handler.body)) return;
        if (hasCleanupMarker(context, node)) return;
        context.report({ node: handler, messageId: 'emptyCatchHandler' });
      },
    };
  },
};

export default rule;
