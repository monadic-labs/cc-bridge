/**
 * ESLint rule: daemon-detached
 *
 * Ensures that any spawn of the proxy/daemon process uses
 * `detached: true` and `stdio: "ignore"`, followed by `.unref()`.
 * This prevents the daemon from being killed when the parent terminal closes.
 */

"use strict";

const WATCHER_MARKERS = ["ccb-watchdog.js", "ccb.js"];

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Watcher/daemon spawns must use detached:true, stdio:'ignore', and .unref()",
      category: "Bug Prevention",
      recommended: true
    },
    schema: [],
    messages: {
      missingDetached:
        "Daemon spawn must include `detached: true` in options — closing the parent terminal will kill the daemon.",
      missingStdioIgnore:
        "Daemon spawn must include `stdio: 'ignore'` — pipe stdio keeps the parent process alive.",
      missingUnref:
        "Daemon spawn result must call `.unref()` — without it the parent process waits for the child to exit."
    }
  },

  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;

        // Match spawn(process.execPath, [..., "ccb-watchdog.js", ...], { ... })
        if (callee.type !== "Identifier" || callee.name !== "spawn") {
          return;
        }

        const args = node.arguments;
        if (args.length < 2) return;

        // Check if second arg references watchdog
        const secondArg = args[1];
        if (!secondArg) return;

        const isWatcherSpawn = (() => {
          if (secondArg.type === "ArrayExpression") {
            return secondArg.elements.some(
              (el) =>
                el &&
                el.type === "Literal" &&
                typeof el.value === "string" &&
                WATCHER_MARKERS.some((m) => el.value.includes(m))
            );
          }
          // Variable reference — can't statically determine, skip
          return false;
        })();

        if (!isWatcherSpawn) return;

        // Get options object (third arg)
        const optsArg = args[2];
        if (!optsArg || optsArg.type !== "ObjectExpression") {
          context.report({ node, messageId: "missingDetached" });
          context.report({ node, messageId: "missingStdioIgnore" });
          return;
        }

        const hasDetached = optsArg.properties.some(
          (p) =>
            p.type === "Property" &&
            p.key.type === "Identifier" &&
            p.key.name === "detached" &&
            p.value.type === "Literal" &&
            p.value.value === true
        );

        const hasStdioIgnore = optsArg.properties.some(
          (p) =>
            p.type === "Property" &&
            p.key.type === "Identifier" &&
            p.key.name === "stdio" &&
            (
              (p.value.type === "Literal" && p.value.value === "ignore") ||
              (p.value.type === "ArrayExpression" && p.value.elements.every(e => e.type === "Literal" && e.value === "ignore"))
            )
        );

        if (!hasDetached) {
          context.report({ node, messageId: "missingDetached" });
        }
        if (!hasStdioIgnore) {
          context.report({ node, messageId: "missingStdioIgnore" });
        }

        // Check that .unref() is called on the result
        if (!hasUnrefInScope(node)) {
          context.report({ node, messageId: "missingUnref" });
        }
      }
    };
  }
};

function hasUnrefInScope(spawnNode) {
  // Walk up to find if the spawn result is assigned and .unref() is called
  let parent = spawnNode.parent;
  while (parent) {
    if (parent.type === "VariableDeclarator" && parent.init === spawnNode) {
      const varName =
        parent.id && parent.id.type === "Identifier" ? parent.id.name : null;
      if (!varName) return false;
      // Search the enclosing block for <varName>.unref()
      const block = findEnclosingBlock(parent);
      if (block) return hasMethodCall(block, varName, "unref");
      return false;
    }
    parent = parent.parent;
  }
  return false;
}

function findEnclosingBlock(node) {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "BlockStatement" || parent.type === "Program") {
      return parent;
    }
    parent = parent.parent;
  }
  return null;
}

function hasMethodCall(block, varName, method) {
  const body = block.body || [];
  for (const stmt of body) {
    if (
      stmt.type === "ExpressionStatement" &&
      stmt.expression.type === "CallExpression" &&
      stmt.expression.callee.type === "MemberExpression" &&
      stmt.expression.callee.object.type === "Identifier" &&
      stmt.expression.callee.object.name === varName &&
      stmt.expression.callee.property.type === "Identifier" &&
      stmt.expression.callee.property.name === method
    ) {
      return true;
    }
  }
  return false;
}
