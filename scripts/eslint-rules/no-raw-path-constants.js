/**
 * ESLint rule: no-raw-path-constants
 *
 * Forbids inline string literals that match known CC-Bridge path segments /
 * filenames which must come from src/core/constants.js.
 *
 * Reports an error with the name of the constant to use instead.
 */

'use strict';

/** Map of forbidden literal value → suggested constant name */
const FORBIDDEN_SEGMENTS = new Map([
    ['.ccb',              'CCB_DIR_NAME'],
    ['config.json',       'CONFIG_FILENAME'],
    ['providers.json',    'PROVIDERS_FILENAME'],
    ['.env',              'ENV_FILENAME'],
    ['logs',              'LOGS_DIR_NAME'],
    ['ccb-watchdog.js',   'WATCHDOG_SCRIPT_NAME'],
]);

export default {
    meta: {
        type: 'suggestion',
        docs: {
            description:
                'Require path segment literals to come from src/core/constants.js',
            category: 'Best Practices',
            recommended: false,
        },
        schema: [],
        messages: {
            useConstant:
                'Use the {{ constant }} constant from src/core/constants.js instead of the raw string "{{ value }}".',
        },
    },

    create(context) {
        const filename = context.filename;

        // Allow the constants definition file itself
        if (filename.includes('constants.js')) return {};

        return {
            Literal(node) {
                if (typeof node.value !== 'string') return;
                
                // Skip imports/requires
                if (node.parent && (node.parent.type === 'ImportDeclaration' || (node.parent.type === 'CallExpression' && node.parent.callee.name === 'require'))) {
                  return;
                }

                const constant = FORBIDDEN_SEGMENTS.get(node.value);
                if (constant) {
                    context.report({
                        node,
                        messageId: 'useConstant',
                        data: { constant, value: node.value },
                    });
                }
            },

            TemplateElement(node) {
                const raw = node.value.raw;
                for (const [segment, constant] of FORBIDDEN_SEGMENTS) {
                    const pattern = new RegExp(
                        `(^|/)${segment.replace('.', '\\.')}(/|$)`
                    );
                    if (pattern.test(raw)) {
                        context.report({
                            node,
                            messageId: 'useConstant',
                            data: { constant, value: segment },
                        });
                        break; 
                    }
                }
            },
        };
    },
};
