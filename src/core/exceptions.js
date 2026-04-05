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

export class UpstreamError extends ProxyError {
  #statusCode;
  #responseBody;

  constructor(message, { statusCode, responseBody, ...props }) {
    super(message, { operation: 'upstream', ...props });
    this.#statusCode = statusCode ?? 0;
    this.#responseBody = responseBody ?? '';
  }

  get statusCode() { return this.#statusCode; }
  get responseBody() { return this.#responseBody; }
}
