import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  __commonJS,
  __toESM
} from "./chunk-ZGXE7NZW.mjs";

// node_modules/extend/index.js
var require_extend = __commonJS({
  "node_modules/extend/index.js"(exports, module) {
    "use strict";
    var hasOwn = Object.prototype.hasOwnProperty;
    var toStr = Object.prototype.toString;
    var defineProperty = Object.defineProperty;
    var gOPD = Object.getOwnPropertyDescriptor;
    var isArray = function isArray2(arr) {
      if (typeof Array.isArray === "function") {
        return Array.isArray(arr);
      }
      return toStr.call(arr) === "[object Array]";
    };
    var isPlainObject = function isPlainObject2(obj) {
      if (!obj || toStr.call(obj) !== "[object Object]") {
        return false;
      }
      var hasOwnConstructor = hasOwn.call(obj, "constructor");
      var hasIsPrototypeOf = obj.constructor && obj.constructor.prototype && hasOwn.call(obj.constructor.prototype, "isPrototypeOf");
      if (obj.constructor && !hasOwnConstructor && !hasIsPrototypeOf) {
        return false;
      }
      var key;
      for (key in obj) {
      }
      return typeof key === "undefined" || hasOwn.call(obj, key);
    };
    var setProperty = function setProperty2(target, options) {
      if (defineProperty && options.name === "__proto__") {
        defineProperty(target, options.name, {
          enumerable: true,
          configurable: true,
          value: options.newValue,
          writable: true
        });
      } else {
        target[options.name] = options.newValue;
      }
    };
    var getProperty = function getProperty2(obj, name) {
      if (name === "__proto__") {
        if (!hasOwn.call(obj, name)) {
          return void 0;
        } else if (gOPD) {
          return gOPD(obj, name).value;
        }
      }
      return obj[name];
    };
    module.exports = function extend3() {
      var options, name, src, copy, copyIsArray, clone;
      var target = arguments[0];
      var i = 1;
      var length = arguments.length;
      var deep = false;
      if (typeof target === "boolean") {
        deep = target;
        target = arguments[1] || {};
        i = 2;
      }
      if (target == null || typeof target !== "object" && typeof target !== "function") {
        target = {};
      }
      for (; i < length; ++i) {
        options = arguments[i];
        if (options != null) {
          for (name in options) {
            src = getProperty(target, name);
            copy = getProperty(options, name);
            if (target !== copy) {
              if (deep && copy && (isPlainObject(copy) || (copyIsArray = isArray(copy)))) {
                if (copyIsArray) {
                  copyIsArray = false;
                  clone = src && isArray(src) ? src : [];
                } else {
                  clone = src && isPlainObject(src) ? src : {};
                }
                setProperty(target, { name, newValue: extend3(deep, clone, copy) });
              } else if (typeof copy !== "undefined") {
                setProperty(target, { name, newValue: copy });
              }
            }
          }
        }
      }
      return target;
    };
  }
});

// node_modules/gaxios/package.json
var require_package = __commonJS({
  "node_modules/gaxios/package.json"(exports, module) {
    module.exports = {
      name: "gaxios",
      version: "7.3.1",
      description: "A simple common HTTP client specifically for Google APIs and services.",
      main: "build/cjs/src/index.js",
      types: "build/cjs/src/index.d.ts",
      files: [
        "build/"
      ],
      exports: {
        ".": {
          import: {
            types: "./build/esm/src/index.d.ts",
            default: "./build/esm/src/index.js"
          },
          require: {
            types: "./build/cjs/src/index.d.ts",
            default: "./build/cjs/src/index.js"
          }
        }
      },
      scripts: {
        lint: "gts check --no-inline-config",
        test: "c8 mocha build/esm/test",
        "presystem-test": "npm run compile",
        "system-test": "mocha build/esm/system-test --timeout 80000",
        compile: "tsc -b ./tsconfig.json ./tsconfig.cjs.json && node utils/enable-esm.mjs",
        fix: "gts fix",
        prepare: "npm run compile",
        pretest: "npm run compile",
        webpack: "webpack",
        "prebrowser-test": "npm run compile",
        "browser-test": "node build/browser-test/browser-test-runner.js",
        docs: "jsdoc -c .jsdoc.js",
        "samples-test": "cd samples/ && npm link ../ && npm test && cd ../",
        prelint: "cd samples; npm link ../; npm install",
        clean: "gts clean"
      },
      repository: {
        type: "git",
        directory: "core/packages/gaxios",
        url: "https://github.com/googleapis/google-cloud-node.git"
      },
      keywords: [
        "google"
      ],
      engines: {
        node: ">=18"
      },
      author: "Google, LLC",
      license: "Apache-2.0",
      devDependencies: {
        "@babel/plugin-proposal-private-methods": "^7.18.6",
        "@types/cors": "^2.8.6",
        "@types/express": "^5.0.0",
        "@types/extend": "^3.0.1",
        "@types/mocha": "^10.0.10",
        "@types/multiparty": "4.2.1",
        "@types/mv": "^2.1.0",
        "@types/ncp": "^2.0.8",
        "@types/node": "^24.0.0",
        "@types/sinon": "^21.0.0",
        "@types/tmp": "^0.2.6",
        assert: "^2.0.0",
        browserify: "^17.0.0",
        c8: "^10.1.3",
        cors: "^2.8.5",
        express: "^5.0.0",
        gts: "^6.0.2",
        "is-docker": "^3.0.0",
        jsdoc: "^4.0.4",
        "jsdoc-fresh": "^5.0.0",
        "jsdoc-region-tag": "^4.0.0",
        karma: "^6.0.0",
        "karma-chrome-launcher": "^3.0.0",
        "karma-coverage": "^2.0.0",
        "karma-firefox-launcher": "^2.0.0",
        "karma-mocha": "^2.0.0",
        "karma-remap-coverage": "^0.1.5",
        "karma-sourcemap-loader": "^0.4.0",
        "karma-webpack": "^5.0.0",
        mocha: "^11.1.0",
        multiparty: "^4.2.1",
        mv: "^2.1.1",
        ncp: "^2.0.0",
        nock: "14.0.5",
        "null-loader": "^4.0.1",
        "pack-n-play": "^4.0.0",
        puppeteer: "^24.0.0",
        sinon: "21.0.3",
        "stream-browserify": "^3.0.0",
        tmp: "0.2.7",
        "ts-loader": "^9.5.2",
        typescript: "5.8.3",
        "undici-types": "^7.24.1",
        webpack: "^5.97.1",
        "webpack-cli": "^6.0.1"
      },
      dependencies: {
        extend: "^3.0.2",
        "https-proxy-agent": "^7.0.1",
        "node-fetch": "^3.3.2"
      },
      homepage: "https://github.com/googleapis/google-cloud-node/tree/main/core/packages/gaxios"
    };
  }
});

// node_modules/gaxios/build/esm/src/util.cjs
var require_util = __commonJS({
  "node_modules/gaxios/build/esm/src/util.cjs"(exports, module) {
    "use strict";
    var pkg2 = require_package();
    module.exports = { pkg: pkg2 };
  }
});

// packages/sources/apple/calendar/dist/google-calendar-attachments.js
import { writeFile } from "node:fs/promises";

// node_modules/gaxios/build/esm/src/gaxios.js
var import_extend2 = __toESM(require_extend(), 1);
import { Agent as HTTPSAgent } from "https";

// node_modules/gaxios/build/esm/src/common.js
var import_extend = __toESM(require_extend(), 1);
var import_util = __toESM(require_util(), 1);
var pkg = import_util.default.pkg;
var GAXIOS_ERROR_SYMBOL = /* @__PURE__ */ Symbol.for(`${pkg.name}-gaxios-error`);
var GaxiosError = class _GaxiosError extends Error {
  config;
  response;
  /**
   * An error code.
   * Can be a system error code, DOMException error name, or any error's 'code' property where it is a `string`.
   *
   * It is only a `number` when the cause is sourced from an API-level error (AIP-193).
   *
   * @see {@link https://nodejs.org/api/errors.html#errorcode error.code}
   * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/DOMException#error_names DOMException#error_names}
   * @see {@link https://google.aip.dev/193#http11json-representation AIP-193}
   *
   * @example
   * 'ECONNRESET'
   *
   * @example
   * 'TimeoutError'
   *
   * @example
   * 500
   */
  code;
  /**
   * An HTTP Status code.
   * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/Response/status Response#status}
   *
   * @example
   * 500
   */
  status;
  /**
   * @deprecated use {@link GaxiosError.cause} instead.
   *
   * @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/cause Error#cause}
   *
   * @privateRemarks
   *
   * We will want to remove this property later as the modern `cause` property is better suited
   * for displaying and relaying nested errors. Keeping this here makes the resulting
   * error log larger than it needs to be.
   *
   */
  error;
  /**
   * Support `instanceof` operator for `GaxiosError` across builds/duplicated files.
   *
   * @see {@link GAXIOS_ERROR_SYMBOL}
   * @see {@link GaxiosError[Symbol.hasInstance]}
   * @see {@link https://github.com/microsoft/TypeScript/issues/13965#issuecomment-278570200}
   * @see {@link https://stackoverflow.com/questions/46618852/require-and-instanceof}
   * @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/@@hasInstance#reverting_to_default_instanceof_behavior}
   */
  [GAXIOS_ERROR_SYMBOL] = pkg.version;
  /**
   * Support `instanceof` operator for `GaxiosError` across builds/duplicated files.
   *
   * @see {@link GAXIOS_ERROR_SYMBOL}
   * @see {@link GaxiosError[GAXIOS_ERROR_SYMBOL]}
   */
  static [Symbol.hasInstance](instance2) {
    if (instance2 && typeof instance2 === "object" && GAXIOS_ERROR_SYMBOL in instance2 && instance2[GAXIOS_ERROR_SYMBOL] === pkg.version) {
      return true;
    }
    return Function.prototype[Symbol.hasInstance].call(_GaxiosError, instance2);
  }
  constructor(message, config, response, cause) {
    super(message, { cause });
    this.config = config;
    this.response = response;
    this.error = cause instanceof Error ? cause : void 0;
    this.config = (0, import_extend.default)(true, {}, config);
    if (this.response) {
      this.response.config = (0, import_extend.default)(true, {}, this.response.config);
    }
    if (this.response) {
      try {
        this.response.data = translateData(
          this.config.responseType,
          // workaround for `node-fetch`'s `.data` deprecation...
          this.response?.bodyUsed ? this.response?.data : void 0
        );
      } catch {
      }
      this.status = this.response.status;
    }
    if (cause instanceof DOMException) {
      this.code = cause.name;
    } else if (cause && typeof cause === "object" && "code" in cause && (typeof cause.code === "string" || typeof cause.code === "number")) {
      this.code = cause.code;
    }
  }
  /**
   * An AIP-193 conforming error extractor.
   *
   * @see {@link https://google.aip.dev/193#http11json-representation AIP-193}
   *
   * @internal
   * @expiremental
   *
   * @param res the response object
   * @returns the extracted error information
   */
  static extractAPIErrorFromResponse(res, defaultErrorMessage = "The request failed") {
    let message = defaultErrorMessage;
    if (typeof res.data === "string") {
      message = res.data;
    }
    if (res.data && typeof res.data === "object" && "error" in res.data && res.data.error && !res.ok) {
      if (typeof res.data.error === "string") {
        return {
          message: res.data.error,
          code: res.status,
          status: res.statusText
        };
      }
      if (typeof res.data.error === "object") {
        message = "message" in res.data.error && typeof res.data.error.message === "string" ? res.data.error.message : message;
        const status = "status" in res.data.error && typeof res.data.error.status === "string" ? res.data.error.status : res.statusText;
        const code = "code" in res.data.error && typeof res.data.error.code === "number" ? res.data.error.code : res.status;
        if ("errors" in res.data.error && Array.isArray(res.data.error.errors)) {
          const errorMessages = [];
          for (const e of res.data.error.errors) {
            if (typeof e === "object" && "message" in e && typeof e.message === "string") {
              errorMessages.push(e.message);
            }
          }
          return Object.assign({
            message: errorMessages.join("\n") || message,
            code,
            status
          }, res.data.error);
        }
        return Object.assign({
          message,
          code,
          status
        }, res.data.error);
      }
    }
    return {
      message,
      code: res.status,
      status: res.statusText
    };
  }
};
function translateData(responseType, data) {
  switch (responseType) {
    case "stream":
      return data;
    case "json":
      return JSON.parse(JSON.stringify(data));
    case "arraybuffer":
      return JSON.parse(Buffer.from(data).toString("utf8"));
    case "blob":
      return JSON.parse(data.text());
    default:
      return data;
  }
}
function defaultErrorRedactor(data) {
  const REDACT = "<<REDACTED> - See `errorRedactor` option in `gaxios` for configuration>.";
  function redactHeaders(headers) {
    if (!headers)
      return;
    headers.forEach((_, key) => {
      if (/^authentication$/i.test(key) || /^authorization$/i.test(key) || /secret/i.test(key))
        headers.set(key, REDACT);
    });
  }
  function redactString(obj, key) {
    if (typeof obj === "object" && obj !== null && typeof obj[key] === "string") {
      const text = obj[key];
      if (/grant_type=/i.test(text) || /assertion=/i.test(text) || /secret/i.test(text)) {
        obj[key] = REDACT;
      }
    }
  }
  function redactObject(obj) {
    if (!obj || typeof obj !== "object") {
      return;
    } else if (obj instanceof FormData || obj instanceof URLSearchParams || // support `node-fetch` FormData/URLSearchParams
    "forEach" in obj && "set" in obj) {
      obj.forEach((_, key) => {
        if (["grant_type", "assertion"].includes(key) || /secret/.test(key)) {
          obj.set(key, REDACT);
        }
      });
    } else {
      if ("grant_type" in obj) {
        obj["grant_type"] = REDACT;
      }
      if ("assertion" in obj) {
        obj["assertion"] = REDACT;
      }
      if ("client_secret" in obj) {
        obj["client_secret"] = REDACT;
      }
    }
  }
  if (data.config) {
    redactHeaders(data.config.headers);
    redactString(data.config, "data");
    redactObject(data.config.data);
    redactString(data.config, "body");
    redactObject(data.config.body);
    if (data.config.url.searchParams.has("token")) {
      data.config.url.searchParams.set("token", REDACT);
    }
    if (data.config.url.searchParams.has("client_secret")) {
      data.config.url.searchParams.set("client_secret", REDACT);
    }
  }
  if (data.response) {
    defaultErrorRedactor({ config: data.response.config });
    redactHeaders(data.response.headers);
    if (data.response.bodyUsed) {
      redactString(data.response, "data");
      redactObject(data.response.data);
    }
  }
  return data;
}

// node_modules/gaxios/build/esm/src/retry.js
async function getRetryConfig(err) {
  let config = getConfig(err);
  if (!err || !err.config || !config && !err.config.retry) {
    return { shouldRetry: false };
  }
  config = config || {};
  config.currentRetryAttempt = config.currentRetryAttempt || 0;
  config.retry = config.retry === void 0 || config.retry === null ? 3 : config.retry;
  config.httpMethodsToRetry = config.httpMethodsToRetry || [
    "GET",
    "HEAD",
    "PUT",
    "OPTIONS",
    "DELETE"
  ];
  config.noResponseRetries = config.noResponseRetries === void 0 || config.noResponseRetries === null ? 2 : config.noResponseRetries;
  config.retryDelayMultiplier = config.retryDelayMultiplier ? config.retryDelayMultiplier : 2;
  config.timeOfFirstRequest = config.timeOfFirstRequest ? config.timeOfFirstRequest : Date.now();
  config.totalTimeout = config.totalTimeout ? config.totalTimeout : Number.MAX_SAFE_INTEGER;
  config.maxRetryDelay = config.maxRetryDelay ? config.maxRetryDelay : Number.MAX_SAFE_INTEGER;
  const retryRanges = [
    // https://en.wikipedia.org/wiki/List_of_HTTP_status_codes
    // 1xx - Retry (Informational, request still processing)
    // 2xx - Do not retry (Success)
    // 3xx - Do not retry (Redirect)
    // 4xx - Do not retry (Client errors)
    // 408 - Retry ("Request Timeout")
    // 429 - Retry ("Too Many Requests")
    // 5xx - Retry (Server errors)
    [100, 199],
    [408, 408],
    [429, 429],
    [500, 599]
  ];
  config.statusCodesToRetry = config.statusCodesToRetry || retryRanges;
  err.config.retryConfig = config;
  const shouldRetryFn = config.shouldRetry || shouldRetryRequest;
  if (!await shouldRetryFn(err)) {
    return { shouldRetry: false, config: err.config };
  }
  const delay = getNextRetryDelay(config);
  err.config.retryConfig.currentRetryAttempt += 1;
  const backoff = config.retryBackoff ? config.retryBackoff(err, delay) : new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
  if (config.onRetryAttempt) {
    await config.onRetryAttempt(err);
  }
  await backoff;
  return { shouldRetry: true, config: err.config };
}
function shouldRetryRequest(err) {
  const config = getConfig(err);
  if (err.config.signal?.aborted && err.code !== "TimeoutError" || err.code === "AbortError") {
    return false;
  }
  if (!config || config.retry === 0) {
    return false;
  }
  if (!err.response && (config.currentRetryAttempt || 0) >= config.noResponseRetries) {
    return false;
  }
  if (!config.httpMethodsToRetry || !config.httpMethodsToRetry.includes(err.config.method?.toUpperCase() || "GET")) {
    return false;
  }
  if (err.response && err.response.status) {
    let isInRange = false;
    for (const [min, max] of config.statusCodesToRetry) {
      const status = err.response.status;
      if (status >= min && status <= max) {
        isInRange = true;
        break;
      }
    }
    if (!isInRange) {
      return false;
    }
  }
  config.currentRetryAttempt = config.currentRetryAttempt || 0;
  if (config.currentRetryAttempt >= config.retry) {
    return false;
  }
  return true;
}
function getConfig(err) {
  if (err && err.config && err.config.retryConfig) {
    return err.config.retryConfig;
  }
  return;
}
function getNextRetryDelay(config) {
  const retryDelay = config.currentRetryAttempt ? 0 : config.retryDelay ?? 100;
  const calculatedDelay = retryDelay + (Math.pow(config.retryDelayMultiplier, config.currentRetryAttempt) - 1) / 2 * 1e3;
  const maxAllowableDelay = config.totalTimeout - (Date.now() - config.timeOfFirstRequest);
  return Math.min(calculatedDelay, maxAllowableDelay, config.maxRetryDelay);
}

// node_modules/gaxios/build/esm/src/gaxios.js
import { Readable } from "stream";

// node_modules/gaxios/build/esm/src/interceptor.js
var GaxiosInterceptorManager = class extends Set {
};

// node_modules/gaxios/build/esm/src/gaxios.js
var _a;
var randomUUID = async () => globalThis.crypto?.randomUUID() || (await import("crypto")).randomUUID();
var HTTP_STATUS_NO_CONTENT = 204;
var Gaxios = class {
  agentCache = /* @__PURE__ */ new Map();
  /**
   * Default HTTP options that will be used for every HTTP request.
   */
  defaults;
  /**
   * Interceptors
   */
  interceptors;
  /**
   * The Gaxios class is responsible for making HTTP requests.
   * @param defaults The default set of options to be used for this instance.
   */
  constructor(defaults) {
    this.defaults = defaults || {};
    this.interceptors = {
      request: new GaxiosInterceptorManager(),
      response: new GaxiosInterceptorManager()
    };
  }
  /**
   * A {@link fetch `fetch`} compliant API for {@link Gaxios}.
   *
   * @remarks
   *
   * This is useful as a drop-in replacement for `fetch` API usage.
   *
   * @example
   *
   * ```ts
   * const gaxios = new Gaxios();
   * const myFetch: typeof fetch = (...args) => gaxios.fetch(...args);
   * await myFetch('https://example.com');
   * ```
   *
   * @param args `fetch` API or `Gaxios#request` parameters
   * @returns the {@link Response} with Gaxios-added properties
   */
  fetch(...args) {
    const input = args[0];
    const init = args[1];
    let url = void 0;
    const headers = new Headers();
    if (typeof input === "string") {
      url = new URL(input);
    } else if (input instanceof URL) {
      url = input;
    } else if (input && input.url) {
      url = new URL(input.url);
    }
    if (input && typeof input === "object" && "headers" in input) {
      _a.mergeHeaders(headers, input.headers);
    }
    if (init) {
      _a.mergeHeaders(headers, new Headers(init.headers));
    }
    if (typeof input === "object" && !(input instanceof URL)) {
      return this.request({ ...init, ...input, headers, url });
    } else {
      return this.request({ ...init, headers, url });
    }
  }
  /**
   * Perform an HTTP request with the given options.
   * @param opts Set of HTTP options that will be used for this HTTP request.
   */
  async request(opts = {}) {
    let prepared = await this.#prepareRequest(opts);
    prepared = await this.#applyRequestInterceptors(prepared);
    return this.#applyResponseInterceptors(this._request(prepared));
  }
  async _defaultAdapter(config) {
    const fetchImpl = config.fetchImplementation || this.defaults.fetchImplementation || await _a.#getFetch();
    const preparedOpts = { ...config };
    delete preparedOpts.data;
    const res = await fetchImpl(config.url, preparedOpts);
    const data = await this.getResponseData(config, res);
    if (!Object.getOwnPropertyDescriptor(res, "data")?.configurable) {
      Object.defineProperties(res, {
        data: {
          configurable: true,
          writable: true,
          enumerable: true,
          value: data
        }
      });
    }
    return Object.assign(res, { config, data });
  }
  /**
   * Internal, retryable version of the `request` method.
   * @param opts Set of HTTP options that will be used for this HTTP request.
   */
  async _request(opts) {
    try {
      let translatedResponse;
      if (opts.adapter) {
        translatedResponse = await opts.adapter(opts, this._defaultAdapter.bind(this));
      } else {
        translatedResponse = await this._defaultAdapter(opts);
      }
      if (!opts.validateStatus(translatedResponse.status)) {
        if (opts.responseType === "stream") {
          const response = [];
          for await (const chunk of translatedResponse.data) {
            response.push(chunk);
          }
          translatedResponse.data = Buffer.concat(response.map((c) => typeof c === "string" ? Buffer.from(c) : c)).toString("utf8");
        }
        const errorInfo = GaxiosError.extractAPIErrorFromResponse(translatedResponse, `Request failed with status code ${translatedResponse.status}`);
        throw new GaxiosError(errorInfo?.message, opts, translatedResponse, errorInfo);
      }
      return translatedResponse;
    } catch (e) {
      let err;
      if (e instanceof GaxiosError) {
        err = e;
      } else if (e instanceof Error) {
        err = new GaxiosError(e.message, opts, void 0, e);
      } else {
        err = new GaxiosError("Unexpected Gaxios Error", opts, void 0, e);
      }
      const { shouldRetry, config } = await getRetryConfig(err);
      if (shouldRetry && config) {
        err.config.retryConfig.currentRetryAttempt = config.retryConfig.currentRetryAttempt;
        opts.retryConfig = err.config?.retryConfig;
        this.#appendTimeoutToSignal(opts);
        return this._request(opts);
      }
      if (opts.errorRedactor) {
        opts.errorRedactor(err);
      }
      throw err;
    }
  }
  async getResponseData(opts, res) {
    if (res.status === HTTP_STATUS_NO_CONTENT) {
      return "";
    }
    if (opts.maxContentLength && res.headers.has("content-length") && opts.maxContentLength < Number.parseInt(res.headers?.get("content-length") || "")) {
      throw new GaxiosError("Response's `Content-Length` is over the limit.", opts, Object.assign(res, { config: opts }));
    }
    switch (opts.responseType) {
      case "stream":
        return res.body;
      case "json": {
        const data = await res.text();
        try {
          return JSON.parse(data);
        } catch {
          return data;
        }
      }
      case "arraybuffer":
        return res.arrayBuffer();
      case "blob":
        return res.blob();
      case "text":
        return res.text();
      default:
        return this.getResponseDataFromContentType(res);
    }
  }
  #urlMayUseProxy(url, noProxy = []) {
    const candidate = new URL(url);
    const noProxyList = [...noProxy];
    const noProxyEnvList = (process.env.NO_PROXY ?? process.env.no_proxy)?.split(",") || [];
    for (const rule of noProxyEnvList) {
      noProxyList.push(rule.trim());
    }
    for (const rule of noProxyList) {
      if (rule instanceof RegExp) {
        if (rule.test(candidate.toString())) {
          return false;
        }
      } else if (rule instanceof URL) {
        if (rule.origin === candidate.origin) {
          return false;
        }
      } else if (rule.startsWith("*.") || rule.startsWith(".")) {
        const cleanedRule = rule.replace(/^\*\./, ".");
        if (candidate.hostname.endsWith(cleanedRule)) {
          return false;
        }
      } else if (rule === candidate.origin || rule === candidate.hostname || rule === candidate.href) {
        return false;
      }
    }
    return true;
  }
  /**
   * Applies the request interceptors. The request interceptors are applied after the
   * call to prepareRequest is completed.
   *
   * @param {GaxiosOptionsPrepared} options The current set of options.
   *
   * @returns {Promise<GaxiosOptionsPrepared>} Promise that resolves to the set of options or response after interceptors are applied.
   */
  async #applyRequestInterceptors(options) {
    let promiseChain = Promise.resolve(options);
    for (const interceptor of this.interceptors.request.values()) {
      if (interceptor) {
        promiseChain = promiseChain.then(interceptor.resolved, interceptor.rejected);
      }
    }
    return promiseChain;
  }
  /**
   * Applies the response interceptors. The response interceptors are applied after the
   * call to request is made.
   *
   * @param {GaxiosOptionsPrepared} options The current set of options.
   *
   * @returns {Promise<GaxiosOptionsPrepared>} Promise that resolves to the set of options or response after interceptors are applied.
   */
  async #applyResponseInterceptors(response) {
    let promiseChain = Promise.resolve(response);
    for (const interceptor of this.interceptors.response.values()) {
      if (interceptor) {
        promiseChain = promiseChain.then(interceptor.resolved, interceptor.rejected);
      }
    }
    return promiseChain;
  }
  /**
   * Validates the options, merges them with defaults, and prepare request.
   *
   * @param options The original options passed from the client.
   * @returns Prepared options, ready to make a request
   */
  async #prepareRequest(options) {
    const preparedHeaders = new Headers(this.defaults.headers);
    _a.mergeHeaders(preparedHeaders, options.headers);
    const opts = (0, import_extend2.default)(true, {}, this.defaults, options);
    if (!opts.url) {
      throw new Error("URL is required.");
    }
    if (opts.baseURL) {
      opts.url = new URL(opts.url, opts.baseURL);
    }
    opts.url = new URL(opts.url);
    if (opts.params) {
      if (opts.paramsSerializer) {
        let additionalQueryParams = opts.paramsSerializer(opts.params);
        if (additionalQueryParams.startsWith("?")) {
          additionalQueryParams = additionalQueryParams.slice(1);
        }
        const prefix = opts.url.toString().includes("?") ? "&" : "?";
        opts.url = opts.url + prefix + additionalQueryParams;
      } else {
        const url = opts.url instanceof URL ? opts.url : new URL(opts.url);
        for (const [key, value] of new URLSearchParams(opts.params)) {
          url.searchParams.append(key, value);
        }
        opts.url = url;
      }
    }
    if (typeof options.maxContentLength === "number") {
      opts.size = options.maxContentLength;
    }
    if (typeof options.maxRedirects === "number") {
      opts.follow = options.maxRedirects;
    }
    const shouldDirectlyPassData = typeof opts.data === "string" || opts.data instanceof ArrayBuffer || opts.data instanceof Blob || // Node 18 does not have a global `File` object
    globalThis.File && opts.data instanceof File || opts.data instanceof FormData || opts.data instanceof Readable || opts.data instanceof ReadableStream || opts.data instanceof String || opts.data instanceof URLSearchParams || ArrayBuffer.isView(opts.data) || // `Buffer` (Node.js), `DataView`, `TypedArray`
    /**
     * @deprecated `node-fetch` or another third-party's request types
     */
    ["Blob", "File", "FormData"].includes(opts.data?.constructor?.name || "");
    if (opts.multipart?.length) {
      const boundary = await randomUUID();
      preparedHeaders.set("content-type", `multipart/related; boundary=${boundary}`);
      opts.body = Readable.from(this.getMultipartRequest(opts.multipart, boundary));
    } else if (shouldDirectlyPassData) {
      opts.body = opts.data;
    } else if (typeof opts.data === "object") {
      if (preparedHeaders.get("Content-Type") === "application/x-www-form-urlencoded") {
        opts.body = opts.paramsSerializer ? opts.paramsSerializer(opts.data) : new URLSearchParams(opts.data);
      } else {
        if (!preparedHeaders.has("content-type")) {
          preparedHeaders.set("content-type", "application/json");
        }
        opts.body = JSON.stringify(opts.data);
      }
    } else if (opts.data) {
      opts.body = opts.data;
    }
    opts.validateStatus = opts.validateStatus || this.validateStatus;
    opts.responseType = opts.responseType || "unknown";
    if (!preparedHeaders.has("accept") && opts.responseType === "json") {
      preparedHeaders.set("accept", "application/json");
    }
    const proxy = opts.proxy || process?.env?.HTTPS_PROXY || process?.env?.https_proxy || process?.env?.HTTP_PROXY || process?.env?.http_proxy;
    if (opts.agent) {
    } else if (proxy && this.#urlMayUseProxy(opts.url, opts.noProxy)) {
      const HttpsProxyAgent = await _a.#getProxyAgent();
      if (this.agentCache.has(proxy)) {
        opts.agent = this.agentCache.get(proxy);
      } else {
        opts.agent = new HttpsProxyAgent(proxy, {
          cert: opts.cert,
          key: opts.key
        });
        this.agentCache.set(proxy, opts.agent);
      }
    } else if (opts.cert && opts.key) {
      if (this.agentCache.has(opts.key)) {
        opts.agent = this.agentCache.get(opts.key);
      } else {
        opts.agent = new HTTPSAgent({
          cert: opts.cert,
          key: opts.key
        });
        this.agentCache.set(opts.key, opts.agent);
      }
    }
    if (typeof opts.errorRedactor !== "function" && opts.errorRedactor !== false) {
      opts.errorRedactor = defaultErrorRedactor;
    }
    if (opts.body && !("duplex" in opts)) {
      opts.duplex = "half";
    }
    this.#appendTimeoutToSignal(opts);
    return Object.assign(opts, {
      headers: preparedHeaders,
      url: opts.url instanceof URL ? opts.url : new URL(opts.url)
    });
  }
  #appendTimeoutToSignal(opts) {
    if (opts.timeout) {
      const timeoutSignal = AbortSignal.timeout(opts.timeout);
      if (opts.signal && !opts.signal.aborted) {
        opts.signal = AbortSignal.any([opts.signal, timeoutSignal]);
      } else {
        opts.signal = timeoutSignal;
      }
    }
  }
  /**
   * By default, throw for any non-2xx status code
   * @param status status code from the HTTP response
   */
  validateStatus(status) {
    return status >= 200 && status < 300;
  }
  /**
   * Attempts to parse a response by looking at the Content-Type header.
   * @param {Response} response the HTTP response.
   * @returns a promise that resolves to the response data.
   */
  async getResponseDataFromContentType(response) {
    let contentType = response.headers.get("Content-Type");
    if (contentType === null) {
      return response.text();
    }
    contentType = contentType.toLowerCase();
    if (contentType.includes("application/json")) {
      let data = await response.text();
      try {
        data = JSON.parse(data);
      } catch {
      }
      return data;
    } else if (contentType.match(/^text\//)) {
      return response.text();
    } else {
      return response.blob();
    }
  }
  /**
   * Creates an async generator that yields the pieces of a multipart/related request body.
   * This implementation follows the spec: https://www.ietf.org/rfc/rfc2387.txt. However, recursive
   * multipart/related requests are not currently supported.
   *
   * @param {GaxiosMultipartOptions[]} multipartOptions the pieces to turn into a multipart/related body.
   * @param {string} boundary the boundary string to be placed between each part.
   */
  async *getMultipartRequest(multipartOptions, boundary) {
    const finale = `--${boundary}--`;
    for (const currentPart of multipartOptions) {
      const partContentType = currentPart.headers.get("Content-Type") || "application/octet-stream";
      const preamble = `--${boundary}\r
Content-Type: ${partContentType}\r
\r
`;
      yield preamble;
      if (typeof currentPart.content === "string") {
        yield currentPart.content;
      } else {
        yield* currentPart.content;
      }
      yield "\r\n";
    }
    yield finale;
  }
  /**
   * A cache for the lazily-loaded proxy agent.
   *
   * Should use {@link Gaxios[#getProxyAgent]} to retrieve.
   */
  // using `import` to dynamically import the types here
  static #proxyAgent;
  /**
   * A cache for the lazily-loaded fetch library.
   *
   * Should use {@link Gaxios[#getFetch]} to retrieve.
   */
  //
  static #fetch;
  /**
   * Imports, caches, and returns a proxy agent - if not already imported
   *
   * @returns A proxy agent
   */
  static async #getProxyAgent() {
    this.#proxyAgent ||= (await import("./dist-65GQYWUP.mjs")).HttpsProxyAgent;
    return this.#proxyAgent;
  }
  static async #getFetch() {
    const hasWindow = typeof window !== "undefined" && !!window;
    this.#fetch ||= hasWindow ? window.fetch : (await import("./src-HVNFLJ3D.mjs")).default;
    return this.#fetch;
  }
  /**
   * Merges headers.
   * If the base headers do not exist a new `Headers` object will be returned.
   *
   * @remarks
   *
   * Using this utility can be helpful when the headers are not known to exist:
   * - if they exist as `Headers`, that instance will be used
   *   - it improves performance and allows users to use their existing references to their `Headers`
   * - if they exist in another form (`HeadersInit`), they will be used to create a new `Headers` object
   * - if the base headers do not exist a new `Headers` object will be created
   *
   * @param base headers to append/overwrite to
   * @param append headers to append/overwrite with
   * @returns the base headers instance with merged `Headers`
   */
  static mergeHeaders(base, ...append) {
    base = base instanceof Headers ? base : new Headers(base);
    for (const headers of append) {
      const add = headers instanceof Headers ? headers : new Headers(headers);
      add.forEach((value, key) => {
        key === "set-cookie" ? base.append(key, value) : base.set(key, value);
      });
    }
    return base;
  }
};
_a = Gaxios;

// node_modules/gaxios/build/esm/src/index.js
var instance = new Gaxios();

// packages/google-auth/dist/platform/google/google-errors.js
function bodyOf(error) {
  if (!(error instanceof GaxiosError))
    return void 0;
  const data = error.response?.data;
  return data;
}
function statusOf(error) {
  return error instanceof GaxiosError ? error.status : void 0;
}
function reasonsOf(error) {
  return bodyOf(error)?.error?.errors?.map((entry) => entry.reason ?? "") ?? [];
}

// packages/sources/apple/calendar/dist/google-calendar-attachments.js
var DRIVE = "https://www.googleapis.com/drive/v3/files";
var GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
var NO_ACCESS = /* @__PURE__ */ new Set([
  "forbidden",
  "insufficientFilePermissions",
  "appNotAuthorizedToFile",
  "domainPolicy",
  "cannotDownloadAbusiveFile",
  // Drive exports a Google Docs file only up to 10 MB, and exports no folder.
  "exportSizeLimitExceeded",
  "cannotExportFile"
]);
function googleCalendarAttachments(requester) {
  return async ({ uri }, path) => {
    const attachment = parseGoogleAttachment(uri);
    if (attachment === void 0)
      return false;
    let bytes;
    try {
      bytes = attachment.kind === "drive" ? await driveFile(requester, attachment) : await gmailAttachment(requester, attachment.id, attachment.partId);
    } catch (error) {
      const status = statusOf(error);
      if (status === 404 || status === 403 && reasonsOf(error).some((r) => NO_ACCESS.has(r)))
        return false;
      throw error;
    }
    if (bytes === void 0)
      return false;
    await writeFile(path, bytes);
    return true;
  };
}
function parseGoogleAttachment(uri) {
  if (uri.startsWith("?")) {
    const query = new URLSearchParams(uri.slice(1));
    const id = query.get("th");
    const attid = query.get("attid");
    if (query.get("view") !== "att" || !id || !attid?.startsWith("0."))
      return void 0;
    return { kind: "gmail", id, partId: attid.slice(2) };
  }
  if (!URL.canParse(uri))
    return void 0;
  const url = new URL(uri);
  if (url.hostname !== "drive.google.com" && url.hostname !== "docs.google.com")
    return void 0;
  const fileId = /\/d\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get("id");
  if (!fileId)
    return void 0;
  const resourceKey = url.searchParams.get("resourcekey");
  return { kind: "drive", fileId, ...resourceKey ? { resourceKey } : {} };
}
async function driveFile(requester, { fileId, resourceKey }) {
  const file = `${DRIVE}/${encodeURIComponent(fileId)}`;
  const headers = resourceKey ? { "X-Goog-Drive-Resource-Keys": `${fileId}/${resourceKey}` } : void 0;
  const metadata = await requester.request({
    url: `${file}?fields=mimeType,shortcutDetails&supportsAllDrives=true`,
    ...headers ? { headers } : {}
  });
  const mimeType = field(metadata.data, "mimeType");
  if (mimeType === "application/vnd.google-apps.shortcut") {
    const shortcut = field(metadata.data, "shortcutDetails");
    const targetId = field(shortcut, "targetId");
    const targetKey = field(shortcut, "targetResourceKey");
    if (typeof targetId !== "string")
      throw new TypeError(`Drive shortcut ${fileId} has no target`);
    return driveFile(requester, {
      fileId: targetId,
      ...typeof targetKey === "string" ? { resourceKey: targetKey } : {}
    });
  }
  const response = await requester.request({
    url: typeof mimeType === "string" && mimeType.startsWith("application/vnd.google-apps.") ? `${file}/export?mimeType=application%2Fpdf` : `${file}?alt=media&supportsAllDrives=true`,
    responseType: "arraybuffer",
    ...headers ? { headers } : {}
  });
  if (!(response.data instanceof ArrayBuffer))
    throw new TypeError(`Drive returned no file content for ${fileId}`);
  return new Uint8Array(response.data);
}
async function gmailAttachment(requester, id, partId) {
  const messages = await gmailMessages(requester, id);
  for (const message of messages) {
    const messageId = field(message, "id");
    const part = findPart(field(message, "payload"), partId);
    if (typeof messageId !== "string" || part === void 0)
      continue;
    const body = field(part, "body");
    const inline = field(body, "data");
    if (typeof inline === "string")
      return Buffer.from(inline, "base64url");
    const attachmentId = field(body, "attachmentId");
    if (typeof attachmentId !== "string")
      continue;
    const attachment = await requester.request({
      url: `${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
    });
    const data = field(attachment.data, "data");
    if (typeof data !== "string")
      throw new TypeError(`Gmail returned no attachment data for ${id}`);
    return Buffer.from(data, "base64url");
  }
  return void 0;
}
async function gmailMessages(requester, id) {
  try {
    const message = await requester.request({
      url: `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`
    });
    return [message.data];
  } catch (error) {
    if (statusOf(error) !== 404)
      throw error;
    const thread = await requester.request({
      url: `${GMAIL}/threads/${encodeURIComponent(id)}?format=full`
    });
    const messages = field(thread.data, "messages");
    return Array.isArray(messages) ? messages : [];
  }
}
function findPart(part, partId) {
  if (field(part, "partId") === partId)
    return part;
  const children = field(part, "parts");
  if (!Array.isArray(children))
    return void 0;
  for (const child of children) {
    const match = findPart(child, partId);
    if (match !== void 0)
      return match;
  }
  return void 0;
}
function field(value, key) {
  return value !== null && typeof value === "object" ? Reflect.get(value, key) : void 0;
}
export {
  googleCalendarAttachments
};
