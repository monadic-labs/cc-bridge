/**
 * ESLint rule: no-unsafe-command-interpolation
 *
 * Detects template literal interpolation of variables into shell commands
 * passed to execBackground / spawnBackground where the variable is not
 * quoted-wrapped. Unquoted interpolation is a command injection surface.
 */

"use strict";

const SUBPROCESS_FNS = new Set(["execBackground", "spawnBackground", "runCommand"]);

const SAFE_EXPRESSIONS = new Set([
  "LOGS_DIR_NAME",
  "CONFIG_FILENAME",
  "PROVIDERS_FILENAME",
  "ENV_FILENAME",
  "CCB_DIR_NAME"
]);

function isFirstArgOfSubprocess(node) {
  if (
    node.parent &&
    node.parent.type === "CallExpression" &&
    node.parent.arguments[0] === node &&
    node.parent.callee.type === "Identifier" &&
    SUBPROCESS_FNS.has(node.parent.callee.name)
  ) {
    return true;
  }
  if (
    node.parent &&
    node.parent.type === "CallExpression" &&
    node.parent.arguments[0] === node &&
    node.parent.callee.type === "MemberExpression" &&
    node.parent.callee.property.type === "Identifier" &&
    SUBPROCESS_FNS.has(node.parent.callee.property.name)
  ) {
    return true;
  }
  return false;
}

function isSafeExpression(node) {
  if (node.type === "Literal" && typeof node.value === "number") return true;
  if (node.type === "Literal" && typeof node.value === "string") return true;
  if (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "Date" &&
    node.callee.property.name === "now"
  ) {
    return true;
  }
  if (
    node.type === "Identifier" &&
    (SAFE_EXPRESSIONS.has(node.name) || /^[A-Z_]+$/.test(node.name))
  ) {
    return true;
  }
  return false;
}

function isQuotedInTemplate(expr, templateNode) {
  const quasiIndex = templateNode.expressions.indexOf(expr);
  if (quasiIndex === -1) return false;

  let hasOpenQuote = false;
  for (let i = quasiIndex; i >= 0; i--) {
    const raw = templateNode.quasis[i].value.raw;
    for (
      let c = i === quasiIndex ? raw.length - 1 : raw.length - 1;
      c >= 0;
      c--
    ) {
      if (raw[c] === '"' && (c === 0 || raw[c - 1] !== "\\")) {
        hasOpenQuote = true;
        break;
      }
    }
    if (hasOpenQuote) break;
  }

  if (!hasOpenQuote) return false;

  for (let i = quasiIndex + 1; i < templateNode.quasis.length; i++) {
    const raw = templateNode.quasis[i].value.raw;
    for (let c = 0; c < raw.length; c++) {
      if (raw[c] === '"' && (c === 0 || raw[c - 1] !== "\\")) {
        return true;
      }
    }
  }

  return false;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Detect unquoted variable interpolation in shell commands",
      category: "Security",
      recommended: true
    },
    schema: [],
    messages: {
      unquotedInterpolation:
        "Shell command contains unquoted interpolation of '{{ name }}'. Wrap in quotes or validate the value to prevent command injection.",
    }
  },

  create(context) {
    return {
      TemplateLiteral(node) {
        if (!isFirstArgOfSubprocess(node)) return;
        if (node.expressions.length === 0) return;

        for (const expr of node.expressions) {
          if (isSafeExpression(expr)) continue;
          if (isQuotedInTemplate(expr, node)) continue;

          let name = "expression";
          if (expr.type === "Identifier") {
            name = expr.name;
          } else if (expr.type === "MemberExpression") {
            if (expr.property.type === "Identifier") {
              name = expr.property.name;
            }
          }

          context.report({
            node: expr,
            messageId: "unquotedInterpolation",
            data: { name }
          });
        }
      }
    };
  }
};
