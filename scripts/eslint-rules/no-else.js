/**
 * ESLint rule: no-else
 *
 * Enforces guard-clause-only control flow. All if blocks must return
 * early, throw, break, or continue. else and else if are forbidden.
 */

"use strict";

export default {
  meta: {
    type: "suggestion",
    docs: {
      description: "Forbid else/else if — use guard clauses only",
      category: "Style",
      recommended: true
    },
    schema: [],
    messages: {
      noElse: "Use guard clauses instead of else/else if. Return early, throw, or continue."
    }
  },

  create(context) {
    return {
      IfStatement(node) {
        if (node.alternate && node.alternate.type === "IfStatement") {
          context.report({ node: node.alternate, messageId: "noElse" });
        } else if (node.alternate) {
          context.report({ node: node.alternate, messageId: "noElse" });
        }
      }
    };
  }
};
