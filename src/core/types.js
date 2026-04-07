import { ArgumentError, ResultAccessError } from './exceptions.js';

export class Result {
  #value;
  #error;
  #isSuccess;

  constructor(value, error, isSuccess) {
    this.#value = value;
    this.#error = error;
    this.#isSuccess = isSuccess;
    Object.freeze(this);
  }

  static ok(value) { return new Result(value, null, true); }
  static fail(error) { return new Result(null, error, false); }

  get isSuccess() { return this.#isSuccess; }
  get value() {
    if (!this.#isSuccess) throw new ResultAccessError('Cannot get value of a failed Result');
    return this.#value;
  }
  get error() {
    if (this.#isSuccess) throw new ResultAccessError('Cannot get error of a successful Result');
    return this.#error;
  }
}

export class Option {
  #value;
  #hasValue;

  constructor(value, hasValue) {
    this.#value = value;
    this.#hasValue = hasValue;
    Object.freeze(this);
  }

  static some(value) {
    if (value === null || value === undefined) throw new ArgumentError('Option.some cannot be null');
    return new Option(value, true);
  }
  static none() { return new Option(null, false); }

  get isSome() { return this.#hasValue; }
  get isNone() { return !this.#hasValue; }
  get value() {
    if (!this.#hasValue) throw new ResultAccessError('Cannot unwrap None');
    return this.#value;
  }
  unwrapOr(defaultValue) { return this.#hasValue ? this.#value : defaultValue; }
}

export class ProxyRequestContext {
  #req;
  #res;
  #id;
  #startTime;
  #routeLabel;
  #reqModel;
  #sessionId;
  #routedHeaders;
  #forwardBody;
  #targetBase;
  #isCustom;
  #rawBody;
  #sanitizationReport;

  constructor({ req, res, id, startTime }) {
    this.#req = req;
    this.#res = res;
    this.#id = id;
    this.#startTime = startTime;
    this.#routeLabel = 'Unknown';
    this.#reqModel = 'unknown';
    this.#sessionId = '';
    this.#routedHeaders = {};
    this.#forwardBody = Buffer.alloc(0);
    this.#targetBase = '';
    this.#isCustom = false;
    this.#rawBody = Buffer.alloc(0);
    this.#sanitizationReport = null;
  }

  get req() { return this.#req; }
  get res() { return this.#res; }
  get id() { return this.#id; }
  get startTime() { return this.#startTime; }
  get routeLabel() { return this.#routeLabel; }
  get reqModel() { return this.#reqModel; }
  get sessionId() { return this.#sessionId; }
  get routedHeaders() { return this.#routedHeaders; }
  get forwardBody() { return this.#forwardBody; }
  get targetBase() { return this.#targetBase; }
  get isCustom() { return this.#isCustom; }
  get rawBody() { return this.#rawBody; }
  get sanitizationReport() { return this.#sanitizationReport; }

  withRouting({ routeLabel, reqModel, sessionId, routedHeaders, forwardBody, targetBase, isCustom, rawBody, sanitizationReport }) {
    const next = new ProxyRequestContext({ req: this.#req, res: this.#res, id: this.#id, startTime: this.#startTime });
    next.#routeLabel = routeLabel;
    next.#reqModel = reqModel;
    next.#sessionId = sessionId;
    next.#routedHeaders = routedHeaders;
    next.#forwardBody = forwardBody;
    next.#targetBase = targetBase;
    next.#isCustom = isCustom ?? false;
    next.#rawBody = rawBody ?? this.#rawBody;
    next.#sanitizationReport = sanitizationReport ?? this.#sanitizationReport;
    return next;
  }
}

export class ProxyResponseContext {
  #proxyRes;
  #res;
  #id;
  #startTime;
  #routeLabel;
  #reqModel;
  #sessionId;
  #headers;
  #req;
  #isCustom;
  #rawBody;
  #forwardBody;
  #sanitizationReport;

  constructor({ proxyRes, res, id, startTime, routeLabel, reqModel, sessionId, headers, req, isCustom, rawBody, forwardBody, sanitizationReport }) {
    this.#proxyRes = proxyRes;
    this.#res = res;
    this.#id = id;
    this.#startTime = startTime;
    this.#routeLabel = routeLabel;
    this.#reqModel = reqModel;
    this.#sessionId = sessionId;
    this.#headers = headers;
    this.#req = req;
    this.#isCustom = isCustom ?? false;
    this.#rawBody = rawBody ?? Buffer.alloc(0);
    this.#forwardBody = forwardBody ?? Buffer.alloc(0);
    this.#sanitizationReport = sanitizationReport ?? null;
    Object.freeze(this);
  }

  get proxyRes() { return this.#proxyRes; }
  get res() { return this.#res; }
  get id() { return this.#id; }
  get startTime() { return this.#startTime; }
  get routeLabel() { return this.#routeLabel; }
  get reqModel() { return this.#reqModel; }
  get sessionId() { return this.#sessionId; }
  get headers() { return this.#headers; }
  get req() { return this.#req; }
  get isCustom() { return this.#isCustom; }
  get rawBody() { return this.#rawBody; }
  get forwardBody() { return this.#forwardBody; }
  get sanitizationReport() { return this.#sanitizationReport; }
}

export class RequestInfo {
  #id;
  #route;
  #url;
  #headers;
  #body;
  #sessionId;

  constructor({ id, route, url, headers, body, sessionId }) {
    if (!id || id < 1) throw new ArgumentError('id must be positive');
    this.#id = id;
    this.#route = route ?? 'unknown';
    this.#url = url ?? '/';
    this.#headers = Object.freeze({ ...headers });
    this.#body = body;
    this.#sessionId = sessionId ?? '';
    Object.freeze(this);
  }

  get id() { return this.#id; }
  get route() { return this.#route; }
  get url() { return this.#url; }
  get headers() { return this.#headers; }
  get body() { return this.#body; }
  get sessionId() { return this.#sessionId; }
  get contentLength() { return this.#headers['content-length'] ?? '?'; }
  get messageCount() { return Array.isArray(this.#body?.messages) ? this.#body.messages.length : 0; }
  get model() { return this.#body?.model ?? 'unknown'; }
}

export class SseMetadata {
  #blocks;
  #inputTokens;
  #outputTokens;
  #model;
  #stopReason;
  #error;

  constructor({ blocks, inputTokens, outputTokens, model, stopReason, error }) {
    this.#blocks = Object.freeze([...(blocks ?? [])]);
    this.#inputTokens = inputTokens ?? 0;
    this.#outputTokens = outputTokens ?? 0;
    this.#model = model;
    this.#stopReason = stopReason;
    this.#error = error;
    Object.freeze(this);
  }

  get blocks() { return this.#blocks; }
  get inputTokens() { return this.#inputTokens; }
  get outputTokens() { return this.#outputTokens; }
  get model() { return this.#model; }
  get stopReason() { return this.#stopReason; }
  get error() { return this.#error; }
  get hasError() { return this.#error !== null; }
}

export class ContentBlockInfo {
  #type;
  #name;
  #signature;

  constructor({ type, name, signature }) {
    this.#type = type;
    this.#name = name;
    this.#signature = signature;
    Object.freeze(this);
  }

  get type() { return this.#type; }
  get name() { return this.#name; }
  get signature() { return this.#signature; }

  toSummary() {
    let s = this.#type;
    if (this.#name) s += `(${this.#name})`;
    if (this.#signature) s += ` sig:${this.#signature.slice(0, 8)}...`;
    return s;
  }
}

export class RequestSummary {
  #id;
  #route;
  #model;
  #status;
  #duration;
  #inputTokens;
  #outputTokens;
  #timestamp;

  constructor({ id, route, model, status, duration, inputTokens, outputTokens, timestamp }) {
    this.#id = id;
    this.#route = route ?? 'unknown';
    this.#model = model ?? 'unknown';
    this.#status = status ?? 0;
    this.#duration = duration ?? 0;
    this.#inputTokens = inputTokens ?? 0;
    this.#outputTokens = outputTokens ?? 0;
    this.#timestamp = timestamp ?? new Date().toISOString();
    Object.freeze(this);
  }

  get id() { return this.#id; }
  get route() { return this.#route; }
  get model() { return this.#model; }
  get status() { return this.#status; }
  get duration() { return this.#duration; }
  get inputTokens() { return this.#inputTokens; }
  get outputTokens() { return this.#outputTokens; }
  get timestamp() { return this.#timestamp; }

  toLogLine() {
    return `#${this.#id} ${this.#route} | ${this.#status} | ${this.#duration}ms | in:${this.#inputTokens} out:${this.#outputTokens}`;
  }
}

export class ResponseInfo {
  #statusCode;
  #headers;
  #rawBody;
  #duration;

  constructor({ statusCode, headers, rawBody, duration }) {
    this.#statusCode = statusCode ?? 0;
    this.#headers = Object.freeze({ ...headers });
    this.#rawBody = rawBody ?? '';
    this.#duration = duration ?? 0;
    Object.freeze(this);
  }

  get statusCode() { return this.#statusCode; }
  get headers() { return this.#headers; }
  get rawBody() { return this.#rawBody; }
  get duration() { return this.#duration; }
  get isSse() { return (this.#headers['content-type'] ?? '').includes('text/event-stream'); }
  get isError() { return this.#statusCode >= 400; }
}

export class RoutingResult {
  #forwardBody;
  #targetBase;
  #label;
  #isCustom;
  #sanitizationReport;

  constructor({ forwardBody, targetBase, label, isCustom, sanitizationReport }) {
    this.#forwardBody = forwardBody;
    this.#targetBase = targetBase;
    this.#label = label;
    this.#isCustom = isCustom ?? false;
    this.#sanitizationReport = sanitizationReport ?? null;
    Object.freeze(this);
  }

  get forwardBody() { return this.#forwardBody; }
  get targetBase() { return this.#targetBase; }
  get label() { return this.#label; }
  get isCustom() { return this.#isCustom; }
  get sanitizationReport() { return this.#sanitizationReport; }
}
