/**
 * ESLint rule: no-generic-error
 *
 * Bans throwing generic Error in src/. Use domain-specific exceptions
 * from src/core/exceptions.js (ConfigError, RoutingError, etc.).
 */

"use strict";

import path from "path";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Ban generic new Error() in src/ — use domain exceptions from exceptions.js",
      category: "Best Practices",
      recommended: true
    },
    schema: [],
    messages: {
      noGenericError: "Do not throw generic Error. Use a domain exception from src/core/exceptions.js (ConfigError, RoutingError, ArgumentError, etc.)."
    }
  },

  create(context) {
    const filename = context.filename;
    if (!filename.includes(`${path.sep}src${path.sep}`)) return {};

    return {
      NewExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "Error"
        ) {
          context.report({ node, messageId: "noGenericError" });
        }
      },
      ThrowStatement(node) {
        if (
          node.argument &&
          node.argument.type === "NewExpression" &&
          node.argument.callee.type === "Identifier" &&
          node.argument.callee.name === "Error"
        ) {
          context.report({ node, messageId: "noGenericError" });
        }
      }
    };
  }
};
