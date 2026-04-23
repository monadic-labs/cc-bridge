/**
 * ESLint rule: no-direct-spawn
 *
 * Bans direct usage of spawn/execSync/execFileSync from child_process
 * in src/. The ONLY exemption is src/infra/process-manager.js —
 * that file is the canonical wrapper every other module must use.
 */

"use strict";

import path from "path";

const FORBIDDEN = new Set(["spawn", "execSync", "execFileSync"]);
const ALLOWED_FILE = "process-manager.js";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Ban direct child_process calls in src/ — use process-manager.js",
      category: "Best Practices",
      recommended: true
    },
    schema: [],
    messages: {
      noDirectSpawn: "Do not use {{ name }}() directly in src/. Use the wrapper in src/infra/process-manager.js instead."
    }
  },

  create(context) {
    const filename = context.filename;

    if (filename.endsWith(ALLOWED_FILE)) return {};
    if (!filename.includes(`${path.sep}src${path.sep}`)) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;

        if (callee.type === "Identifier" && callee.name === "require") return;

        if (callee.type === "Identifier" && FORBIDDEN.has(callee.name)) {
          context.report({ node, messageId: "noDirectSpawn", data: { name: callee.name } });
          return;
        }

        if (
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          FORBIDDEN.has(callee.property.name)
        ) {
          context.report({ node, messageId: "noDirectSpawn", data: { name: callee.property.name } });
        }
      }
    };
  }
};
