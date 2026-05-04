import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import noDirectSpawn from "./scripts/eslint-rules/no-direct-spawn.js";
import noElse from "./scripts/eslint-rules/no-else.js";
import noGenericError from "./scripts/eslint-rules/no-generic-error.js";
import noHardcodedSleep from "./scripts/eslint-rules/no-hardcoded-sleep.js";
import daemonDetached from "./scripts/eslint-rules/daemon-detached.js";
import noRawPathConstants from "./scripts/eslint-rules/no-raw-path-constants.js";
import noUnsafeCommandInterpolation from "./scripts/eslint-rules/no-unsafe-command-interpolation.js";

export default defineConfig([
  {
    ignores: ["node_modules/**", ".test-config/**", "coverage/**", "src/infra/gui/**"]
  },
  {
    files: ["src/**/*.js", "bin/**/*.js", "scripts/**/*.js"],
    plugins: {
      js,
      local: {
        rules: {
          "no-direct-spawn": noDirectSpawn,
          "no-else": noElse,
          "no-generic-error": noGenericError,
          "no-hardcoded-sleep": noHardcodedSleep,
          "daemon-detached": daemonDetached,
          "no-raw-path-constants": noRawPathConstants,
          "no-unsafe-command-interpolation": noUnsafeCommandInterpolation
        }
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      "local/no-direct-spawn": "error",
      "local/no-else": "error",
      "local/no-generic-error": "error",
      "local/no-hardcoded-sleep": "error",
      "local/daemon-detached": "error",
      "local/no-raw-path-constants": "error",
      "local/no-unsafe-command-interpolation": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-constant-condition": "off",
      "no-empty": ["error", { allowEmptyCatch: true }]
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly"
      }
    }
  }
]);
