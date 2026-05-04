/**
 * ESLint rule: no-direct-spawn
 *
 * Bans direct usage of spawn / execSync / execFileSync from child_process
 * anywhere in src/. The ONLY exemption is src/infra/process-manager.js —
 * that file is the canonical wrapper every other module must use.
 */

"use strict";

import path from "path";

const FORBIDDEN = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);


export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require spawn/execSync to go through src/infra/process-manager.js — no direct child_process calls in src/",
      category: "Best Practices",
      recommended: true
    },
    schema: [],
    messages: {
      noDirectSpawn:
        "Do not use {{ name }}() directly. Import from src/infra/process-manager.js instead."
    }
  },

  create(context) {
    const filename = context.filename;



    // Enforce in src/, scripts/, and bin/
    const isEnforced = ["src", "scripts", "bin"].some((dir) =>
      filename.includes(`${path.sep}${dir}${path.sep}`)
    );
    if (!isEnforced) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;

        // require("child_process") is fine (mostly for older scripts)
        if (callee.type === "Identifier" && callee.name === "require") {
          return;
        }

        // Direct call: spawn(...), execSync(...)
        if (callee.type === "Identifier" && FORBIDDEN.has(callee.name)) {
          context.report({
            node,
            messageId: "noDirectSpawn",
            data: { name: callee.name }
          });
          return;
        }

        // Member call: child_process.spawn(...) or require('child_process').spawn(...)
        if (
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          FORBIDDEN.has(callee.property.name)
        ) {
          // Exempt pty.spawn
          if (callee.object.type === "Identifier" && callee.object.name === "pty") {
            return;
          }
          context.report({
            node,
            messageId: "noDirectSpawn",
            data: { name: callee.property.name }
          });
        }
      }
    };
  }
};
