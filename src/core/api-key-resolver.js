import path from 'path';
import { ProxyError } from './exceptions.js';
import { Result, Option } from './types.js';
import { providerIdToEnvKey } from './providers.js';
import { CCB_DIR_NAME, ENV_FILENAME } from './constants.js';

const ENV_HINT_PATH = path.posix.join('~/.claude', CCB_DIR_NAME, ENV_FILENAME);

export class ProviderApiKeyError extends ProxyError {
  #providerId;
  #envVar;

  constructor(providerId, envVar) {
    const safeProvider = providerId || '(unknown)';
    const safeEnvVar = envVar || '(unknown)';
    super(
      `Missing API key for provider "${safeProvider}": environment variable ${safeEnvVar} is not set. Define it in ${ENV_HINT_PATH} or your shell environment before routing to this provider.`,
      { operation: 'api-key-resolution', context: { providerId: safeProvider, envVar: safeEnvVar } }
    );
    this.#providerId = safeProvider;
    this.#envVar = safeEnvVar;
  }

  get providerId() { return this.#providerId; }
  get envVar() { return this.#envVar; }
  get httpStatus() { return 400; }
}

function readEnvValue(providerId, env) {
  if (!providerId || typeof providerId !== 'string') return { envVar: '', value: undefined };
  const envVar = providerIdToEnvKey(providerId);
  if (!envVar) return { envVar: '', value: undefined };
  return { envVar, value: env[envVar] };
}

export function requireProviderApiKey(providerId, env = process.env) {
  const { envVar, value } = readEnvValue(providerId, env);
  if (typeof value !== 'string' || value.length === 0) {
    return Result.fail(new ProviderApiKeyError(providerId, envVar));
  }
  return Result.ok(value);
}

export function tryProviderApiKey(providerId, env = process.env) {
  const { value } = readEnvValue(providerId, env);
  if (typeof value !== 'string' || value.length === 0) return Option.none();
  return Option.some(value);
}
