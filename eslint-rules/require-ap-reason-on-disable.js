/**
 * Guard integrity — never silence a guard quietly.
 *
 * An `eslint-disable` comment of any shape must name the anti-pattern id it
 * turns off (AP1..AP9) and give a reason on the same line. This is the edge
 * case in test group T1.3.
 */

const DISABLE = /eslint-disable(-next-line|-line)?\b/;
const AP_ID = /\bAP[1-9]\b/;

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require every eslint-disable comment to name an AP id and a reason on the same line',
    },
    schema: [],
    messages: {
      noApId:
        'AP0: an eslint-disable comment must name the anti-pattern id (AP1..AP9) it silences.',
      noReason:
        'AP0: an eslint-disable comment must give a reason after the AP id, on the same line.',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const text = comment.value;
          if (!DISABLE.test(text)) continue;
          if (!AP_ID.test(text)) {
            context.report({ loc: comment.loc, messageId: 'noApId' });
            continue;
          }
          const after = text.slice(text.search(AP_ID) + 3).trim();
          const reason = after.replace(/^[-:,\s]+/, '').trim();
          if (reason.length < 10) {
            context.report({ loc: comment.loc, messageId: 'noReason' });
          }
        }
      },
    };
  },
};

export default rule;
