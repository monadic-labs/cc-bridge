/**
 * Non-compliant provider request transform extension.
 *
 * For non-Anthropic-compliant providers: strips the `betas` field,
 * flattens the system prompt from array to string, and ensures
 * the model name is set to the real model.
 */

import { getSystem } from '../../core/api-adapter.js';

export const EXTENSION_META = {
  activation: 'always',
  title: 'Non-Compliant Transform',
  description: 'For providers with anthropicCompliant=false: strips the betas field and flattens the system prompt array into a single string. Fires per-request based on the matched provider, not globally.',
  configuredBy: 'providers[*].anthropicCompliant',
};

function flattenSystemPrompt(system) {
  if (!Array.isArray(system)) return system;
  const flattened = system
    .map((s) => (typeof s === 'string' ? s : (typeof s === 'object' && s !== null ? (s.text ?? '') : String(s))))
    .join('\n')
    .trim();
  if (!flattened) return undefined;
  return flattened;
}

export function createNonCompliantTransformExtension() {
  return {
    name: 'non-compliant-transform',

    hooks: {
      requestTransform: {
        order: 10,
        transform: ({ body, provider }) => {
          if (provider?.anthropicCompliant) return body;
          const { betas: _, ...rest } = body;
          return { ...rest, system: flattenSystemPrompt(getSystem(body)) };
        },
      },
    },
  };
}
