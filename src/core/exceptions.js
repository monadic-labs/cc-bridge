export class ProxyError extends Error {
  #operation;
  #requestId;
  #context;

  constructor(message, { operation, requestId, context } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.#operation = operation ?? 'unknown';
    this.#requestId = requestId ?? 0;
    this.#context = context ?? {};
  }

  get operation() { return this.#operation; }
  get requestId() { return this.#requestId; }
  get context() { return Object.freeze({ ...this.#context }); }

  toResponsePayload() {
    return JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: this.message }
    });
  }
}

export class ConfigError extends ProxyError {
  constructor(message, props) { super(message, { operation: 'config', ...props }); }
}

export class ConfigurationMissingException extends ConfigError {
  constructor(message, props) { 
    super(message, props); 
    this.code = 401;
  }
}

export class RoutingError extends ProxyError {
  constructor(message, props) { super(message, { operation: 'routing', ...props }); }
}

export class DecompressionError extends ProxyError {
  constructor(message, props) { super(message, { operation: 'decompression', ...props }); }
}

export class ArgumentError extends ProxyError {
  constructor(message, props) { super(message, { operation: 'argument', ...props }); }
}

export class ResultAccessError extends ProxyError {
  constructor(message, props) { super(message, { operation: 'result-access', ...props }); }
}

export class ReadinessTimeoutException extends ProxyError {
  constructor(message, props) { super(message, { operation: 'process-manager', ...props }); }
}

export class SubprocessTimeoutError extends ProxyError {
  #timeoutMs;
  constructor(message, opts = {}) {
    const { timeoutMs, ...props } = opts;
    super(message, { operation: 'process-manager', ...props });
    this.#timeoutMs = timeoutMs ?? 0;
  }
  get timeoutMs() { return this.#timeoutMs; }
}

export class SubprocessOutputError extends ProxyError {
  #maxBytes;
  constructor(message, opts = {}) {
    const { maxBytes, ...props } = opts;
    super(message, { operation: 'process-manager', ...props });
    this.#maxBytes = maxBytes ?? 0;
  }
  get maxBytes() { return this.#maxBytes; }
}

export class SubprocessExitError extends ProxyError {
  #exitCode;
  constructor(message, opts = {}) {
    const { exitCode, ...props } = opts;
    super(message, { operation: 'process-manager', ...props });
    this.#exitCode = exitCode ?? -1;
  }
  get exitCode() { return this.#exitCode; }
}

export class AuthError extends ProxyError {
  #reason;

  constructor(message, opts = {}) {
    const { reason, ...props } = opts;
    super(message, { operation: 'auth', ...props });
    this.#reason = reason ?? 'unauthorized';
  }

  get reason() { return this.#reason; }
  get httpStatus() { return this.#reason === 'non_loopback_admin' ? 403 : 401; }

  toResponsePayload() {
    return JSON.stringify({
      type: 'error',
      error: { type: 'auth_error', code: this.#reason, message: this.message }
    });
  }
}

export class UpstreamError extends ProxyError {
  #statusCode;
  #responseBody;

  constructor(message, opts = {}) {
    const { statusCode, responseBody, ...props } = opts;
    super(message, { operation: 'upstream', ...props });
    this.#statusCode = statusCode ?? 0;
    this.#responseBody = responseBody ?? '';
  }

  get statusCode() { return this.#statusCode; }
  get responseBody() { return this.#responseBody; }
}

export class CCBSnapshotError extends ProxyError {
  constructor(message, props) { super(message, { operation: 'snapshot', ...props }); }
}

export class SessionInfoError extends ProxyError {
  #metadata;

  constructor(metadata) {
    super('CCB Session Info', { operation: 'session-info' });
    this.#metadata = metadata;
  }

  toResponsePayload() {
    return JSON.stringify({
      type: 'error',
      error: {
        type: 'ccb_session_info',
        ...this.#metadata
      }
    });
  }
}
