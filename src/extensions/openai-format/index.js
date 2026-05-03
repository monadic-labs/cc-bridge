/**
 * OpenAI API format converter extension.
 *
 * Converts between Anthropic and OpenAI API formats for providers that
 * speak the OpenAI chat completion protocol. Fully autonomous — reads
 * its own configuration from the `extensions.openai-format` section
 * of providers.json.
 *
 * Config example:
 *   "extensions": {
 *     "openai-format": {
 *       "providers": {
 *         "synthetic": { "format": "openai" }
 *       }
 *     }
 *   }
 *
 * Uses standard extension hooks:
 *  - requestTransform: converts Anthropic request body to OpenAI format
 *  - sseChunkTransform: converts OpenAI SSE chunks to Anthropic SSE events
 *  - responseTransform: converts full OpenAI responses to Anthropic format
 */

import { convertRequest } from './converters/request.js';
import { convertChunk, convertFullResponse, createState } from './converters/response-sse.js';
import { resolveOpenaiModel } from './model-resolver.js';

export const EXTENSION_META = {
  activation: 'always',
  schema: {
    type: 'object',
    title: 'OpenAI Format',
    description: 'Anthropic ↔ OpenAI API format conversion.',
    properties: {
      providers: {
        type: 'object',
        title: 'Provider Mappings',
        description: 'Declare which providers require OpenAI format conversion.',
        additionalProperties: {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              title: 'Target Format',
              enum: ['openai', 'anthropic'],
              default: 'openai'
            }
          }
        }
      }
    }
  }
};

export function createOpenaiFormatExtension(config = {}) {
  const providerFormats = config.providers ?? {};

  return {
    name: 'openai-format',

    hooks: {
      requestTransform: {
        order: 100,
        transform: ({ body, provider }) => {
          const fmt = providerFormats[provider?.id]?.format;
          if (!fmt || fmt === 'anthropic') return body;
          return convertRequest(body);
        },
      },

      sseChunkTransform: {
        order: 100,
        createState: () => createState(),
        transform: ({ chunk, provider }, state) => {
          const fmt = providerFormats[provider?.id]?.format;
          if (!fmt || fmt === 'anthropic') return chunk;
          return convertChunk(chunk, state);
        },
      },

      responseTransform: {
        order: 100,
        transform: ({ response, provider }) => {
          const fmt = providerFormats[provider?.id]?.format;
          if (!fmt || fmt === 'anthropic') return response;
          return convertFullResponse(response);
        },
      },

      resolveUnmatched: {
        order: 50,
        resolve: async ({ modelName, policy }) => {
          const result = await resolveOpenaiModel(modelName, providerFormats, policy.providerMap);
          if (!result) return null;
          const providerOpt = policy.getProvider(result.providerId);
          if (providerOpt.isNone) return null;
          return { provider: providerOpt.value, model: result.model, providerId: result.providerId };
        },
      },
    },
  };
}
