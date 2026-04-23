/**
 * ESLint rule: no-hardcoded-sleep
 *
 * Bans setTimeout/setInterval with hardcoded delays in src/ except
 * in process-manager.js. Use deterministic polling instead.
 * Does NOT ban retry backoff calculations (sleepAbortable in proxy-upstream).
 */

"use strict";

import path from "path";

const ALLOWED_FILES = new Set(["process-manager.js", "proxy-upstream.js", "proxy-core.js"]);

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Ban hardcoded sleep/delay in src/ — use deterministic polling",
      category: "Best Practices",
      recommended: true
    },
    schema: [],
    messages: {
      noHardcodedSleep: "Avoid arbitrary delays. Use deterministic health-check polling or bounded retry instead."
    }
  },

  create(context) {
    const filename = context.filename;
    if (!filename.includes(`${path.sep}src${path.sep}`)) return {};
    for (const allowed of ALLOWED_FILES) {
      if (filename.endsWith(allowed)) return {};
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        const isTimer =
          (callee.type === "Identifier" && (callee.name === "setTimeout" || callee.name === "setInterval"));

        if (!isTimer) return;

        // Only flag if the delay argument is a literal number (hardcoded)
        if (node.arguments.length >= 2 && node.arguments[1].type === "Literal" && typeof node.arguments[1].value === "number") {
          context.report({ node, messageId: "noHardcodedSleep" });
        }
      }
    };
  }
};
