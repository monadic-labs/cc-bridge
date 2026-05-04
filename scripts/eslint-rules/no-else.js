/**
 * ESLint rule: no-else
 *
 * Forbids the use of 'else' and 'else if' blocks.
 * Encourages early returns, guard clauses, and functional alternatives
 * like maps or polymorphism.
 */

"use strict";

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid 'else' and 'else if' blocks to reduce cyclomatic complexity and encourage early returns.",
      category: "Best Practices",
      recommended: true
    },
    schema: [],
    messages: {
      noElse:
        "The use of 'else' and 'else if' is forbidden. Use guard clauses, early returns, or functional patterns instead."
    }
  },

  create(context) {
    return {
      IfStatement(node) {
        if (node.alternate) {
          context.report({
            node: node.alternate,
            messageId: "noElse"
          });
        }
      }
    };
  }
};
