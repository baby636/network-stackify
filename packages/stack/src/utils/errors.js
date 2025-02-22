/* eslint node-core/documented-errors: "error" */
/* eslint node-core/alphabetize-errors: "error" */
/* eslint node-core/prefer-util-format-errors: "error" */

"use strict";

// The whole point behind this internal module is to allow Node.js to no
// longer be forced to treat every error message change as a semver-major
// change. The NodeError classes here all expose a `code` property whose
// value statically and permanently identifies the error. While the error
// message may change, the code should not.

const messages = new Map();
const codes = {};

const classRegExp = /^([A-Z][a-z0-9]*)+$/;
// Sorted by a rough estimate on most frequently used entries.
const kTypes = [
  "string",
  "function",
  "number",
  "object",
  // Accept 'Function' and 'Object' as alternative to the lower cased version.
  "Function",
  "Object",
  "boolean",
  "bigint",
  "symbol",
];

const MainContextError = Error;
const overrideStackTrace = new WeakMap();
const kNoOverride = Symbol("kNoOverride");
let userStackTraceLimit;
const nodeInternalPrefix = "__node_internal_";
const prepareStackTrace = (globalThis, error, trace) => {
  // API for node internals to override error stack formatting
  // without interfering with userland code.
  if (overrideStackTrace.has(error)) {
    const f = overrideStackTrace.get(error);
    overrideStackTrace.delete(error);
    return f(error, trace);
  }

  const firstFrame = trace[0]?.getFunctionName();
  if (
    firstFrame &&
    String.prototype.startsWith.call(firstFrame, nodeInternalPrefix)
  ) {
    for (let l = trace.length - 1; l >= 0; l--) {
      const fn = trace[l]?.getFunctionName();
      if (fn && String.prototype.startsWith.call(fn, nodeInternalPrefix)) {
        Array.prototype.splice.call(trace, 0, l + 1);
        break;
      }
    }
    // `userStackTraceLimit` is the user value for `Error.stackTraceLimit`,
    // it is updated at every new exception in `captureLargerStackTrace`.
    if (trace.length > userStackTraceLimit)
      Array.prototype.splice.call(trace, userStackTraceLimit);
  }

  const globalOverride = maybeOverridePrepareStackTrace(
    globalThis,
    error,
    trace
  );
  if (globalOverride !== kNoOverride) return globalOverride;

  // Normal error formatting:
  //
  // Error: Message
  //     at function (file)
  //     at file
  const errorString = Error.prototype.toString.call(error);
  if (trace.length === 0) {
    return errorString;
  }
  return `${errorString}\n    at ${Array.prototype.join.call(
    trace,
    "\n    at "
  )}`;
};

const maybeOverridePrepareStackTrace = (globalThis, error, trace) => {
  // Polyfill of V8's Error.prepareStackTrace API.
  // https://crbug.com/v8/7848
  // `globalThis` is the global that contains the constructor which
  // created `error`.
  if (typeof globalThis.Error?.prepareStackTrace === "function") {
    return globalThis.Error.prepareStackTrace(error, trace);
  }
  // We still have legacy usage that depends on the main context's `Error`
  // being used, even when the error is from a different context.
  // TODO(devsnek): evaluate if this can be eventually deprecated/removed.
  if (typeof MainContextError.prepareStackTrace === "function") {
    return MainContextError.prepareStackTrace(error, trace);
  }

  return kNoOverride;
};

// Lazily loaded
let util;
let assert;

let internalUtilInspect = null;
function lazyInternalUtilInspect() {
  if (!internalUtilInspect) {
    internalUtilInspect = require("util");
  }
  return internalUtilInspect;
}

let buffer;
function lazyBuffer() {
  if (buffer === undefined) buffer = require("buffer").Buffer;
  return buffer;
}

const addCodeToName = hideStackFrames(function addCodeToName(err, name, code) {
  // Set the stack
  err = captureLargerStackTrace(err);
  // Add the error code to the name to include it in the stack trace.
  err.name = `${name} [${code}]`;
  // Access the stack to generate the error message including the error code
  // from the name.
  err.stack; // eslint-disable-line no-unused-expressions
  // Reset the name to the actual name.
  if (name === "SystemError") {
    Object.defineProperty(err, "name", {
      value: name,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  } else {
    delete err.name;
  }
});

function isErrorStackTraceLimitWritable() {
  const desc = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
  if (desc === undefined) {
    return Object.isExtensible(Error);
  }

  return Object.prototype.hasOwnProperty.call(desc, "writable")
    ? desc.writable
    : desc.set !== undefined;
}

// A specialized Error that includes an additional info property with
// additional information about the error condition.
// It has the properties present in a UVException but with a custom error
// message followed by the uv error code and uv error message.
// It also has its own error code with the original uv error context put into
// `err.info`.
// The context passed into this error must have .code, .syscall and .message,
// and may have .path and .dest.
class SystemError extends Error {
  constructor(key, context) {
    const limit = Error.stackTraceLimit;
    if (isErrorStackTraceLimitWritable()) Error.stackTraceLimit = 0;
    super();
    // Reset the limit and setting the name property.
    if (isErrorStackTraceLimitWritable()) Error.stackTraceLimit = limit;
    const prefix = getMessage(key, [], this);
    let message =
      `${prefix}: ${context.syscall} returned ` +
      `${context.code} (${context.message})`;

    if (context.path !== undefined) message += ` ${context.path}`;
    if (context.dest !== undefined) message += ` => ${context.dest}`;

    Object.defineProperty(this, "message", {
      value: message,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    addCodeToName(this, "SystemError", key);

    this.code = key;

    Object.defineProperty(this, "info", {
      value: context,
      enumerable: true,
      configurable: true,
      writable: false,
    });

    Object.defineProperty(this, "errno", {
      get() {
        return context.errno;
      },
      set: (value) => {
        context.errno = value;
      },
      enumerable: true,
      configurable: true,
    });

    Object.defineProperty(this, "syscall", {
      get() {
        return context.syscall;
      },
      set: (value) => {
        context.syscall = value;
      },
      enumerable: true,
      configurable: true,
    });

    if (context.path !== undefined) {
      // TODO(BridgeAR): Investigate why and when the `.toString()` was
      // introduced. The `path` and `dest` properties in the context seem to
      // always be of type string. We should probably just remove the
      // `.toString()` and `Buffer.from()` operations and set the value on the
      // context as the user did.
      Object.defineProperty(this, "path", {
        get() {
          return context.path != null ? context.path.toString() : context.path;
        },
        set: (value) => {
          context.path = value
            ? lazyBuffer().from(value.toString())
            : undefined;
        },
        enumerable: true,
        configurable: true,
      });
    }

    if (context.dest !== undefined) {
      Object.defineProperty(this, "dest", {
        get() {
          return context.dest != null ? context.dest.toString() : context.dest;
        },
        set: (value) => {
          context.dest = value
            ? lazyBuffer().from(value.toString())
            : undefined;
        },
        enumerable: true,
        configurable: true,
      });
    }
  }

  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }

  [Symbol.for("nodejs.util.inspect.custom")](recurseTimes, ctx) {
    return lazyInternalUtilInspect().inspect(this, {
      ...ctx,
      getters: true,
      customInspect: false,
    });
  }
}

function makeSystemErrorWithCode(key) {
  return class NodeError extends SystemError {
    constructor(ctx) {
      super(key, ctx);
    }
  };
}

function makeNodeErrorWithCode(Base, key) {
  return function NodeError(...args) {
    const limit = Error.stackTraceLimit;
    if (isErrorStackTraceLimitWritable()) Error.stackTraceLimit = 0;
    const error = new Base();
    // Reset the limit and setting the name property.
    if (isErrorStackTraceLimitWritable()) Error.stackTraceLimit = limit;
    const message = getMessage(key, args, error);
    Object.defineProperty(error, "message", {
      value: message,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(error, "toString", {
      value() {
        return `${this.name} [${key}]: ${this.message}`;
      },
      enumerable: false,
      writable: true,
      configurable: true,
    });
    addCodeToName(error, Base.name, key);
    error.code = key;
    return error;
  };
}

/**
 * This function removes unnecessary frames from Node.js core errors.
 * @template {(...args: any[]) => any} T
 * @type {(fn: T) => T}
 */
function hideStackFrames(fn) {
  // We rename the functions that will be hidden to cut off the stacktrace
  // at the outermost one
  const hidden = nodeInternalPrefix + fn.name;
  Object.defineProperty(fn, "name", { value: hidden });
  return fn;
}

// Utility function for registering the error codes. Only used here. Exported
// *only* to allow for testing.
function E(sym, val, def, ...otherClasses) {
  // Special case for SystemError that formats the error message differently
  // The SystemErrors only have SystemError as their base classes.
  messages.set(sym, val);
  if (def === SystemError) {
    def = makeSystemErrorWithCode(sym);
  } else {
    def = makeNodeErrorWithCode(def, sym);
  }

  if (otherClasses.length !== 0) {
    otherClasses.forEach((clazz) => {
      def[clazz.name] = makeNodeErrorWithCode(clazz, sym);
    });
  }
  codes[sym] = def;
}

function getMessage(key, args, self) {
  const msg = messages.get(key);

  if (assert === undefined) assert = require("assert");

  if (typeof msg === "function") {
    assert(
      msg.length <= args.length, // Default options do not count.
      `Code: ${key}; The provided arguments length (${args.length}) does not ` +
        `match the required ones (${msg.length}).`
    );
    return Reflect.apply(msg, self, args);
  }

  const expectedLength = (String.prototype.match.call(msg, /%[dfijoOs]/g) || [])
    .length;
  assert(
    expectedLength === args.length,
    `Code: ${key}; The provided arguments length (${args.length}) does not ` +
      `match the required ones (${expectedLength}).`
  );
  if (args.length === 0) return msg;

  Array.prototype.unshift.call(args, msg);
  return Reflect.apply(lazyInternalUtilInspect().format, null, args);
}

const captureLargerStackTrace = hideStackFrames(
  function captureLargerStackTrace(err) {
    const stackTraceLimitIsWritable = isErrorStackTraceLimitWritable();
    if (stackTraceLimitIsWritable) {
      userStackTraceLimit = Error.stackTraceLimit;
      Error.stackTraceLimit = Infinity;
    }
    Error.captureStackTrace(err);
    // Reset the limit
    if (stackTraceLimitIsWritable) Error.stackTraceLimit = userStackTraceLimit;

    return err;
  }
);

/**
 * This used to be util._errnoException().
 *
 * @param {number} err - A libuv error number
 * @param {string} syscall
 * @param {string} [original]
 * @returns {Error}
 */
const errnoException = hideStackFrames(function errnoException(
  err,
  syscall,
  original
) {
  // TODO(joyeecheung): We have to use the type-checked
  // getSystemErrorName(err) to guard against invalid arguments from users.
  // This can be replaced with [ code ] = errmap.get(err) when this method
  // is no longer exposed to user land.
  if (util === undefined) util = require("util");
  const code = util.getSystemErrorName(err);
  const message = original
    ? `${syscall} ${code} ${original}`
    : `${syscall} ${code}`;

  const tmpLimit = Error.stackTraceLimit;
  if (isErrorStackTraceLimitWritable()) Error.stackTraceLimit = 0;
  // eslint-disable-next-line no-restricted-syntax
  const ex = new Error(message);
  if (isErrorStackTraceLimitWritable()) Error.stackTraceLimit = tmpLimit;
  ex.errno = err;
  ex.code = code;
  ex.syscall = syscall;

  return captureLargerStackTrace(ex);
});

/**
 * Deprecated, new function is `uvExceptionWithHostPort()`
 * New function added the error description directly
 * from C++. this method for backwards compatibility
 * @param {number} err - A libuv error number
 * @param {string} syscall
 * @param {string} address
 * @param {number} [port]
 * @param {string} [additional]
 * @returns {Error}
 */
const exceptionWithHostPort = hideStackFrames(function exceptionWithHostPort(
  err,
  syscall,
  address,
  port,
  additional
) {
  // TODO(joyeecheung): We have to use the type-checked
  // getSystemErrorName(err) to guard against invalid arguments from users.
  // This can be replaced with [ code ] = errmap.get(err) when this method
  // is no longer exposed to user land.
  if (util === undefined) util = require("util");
  const code = util.getSystemErrorName(err);
  let details = "";
  if (port && port > 0) {
    details = ` ${address}:${port}`;
  } else if (address) {
    details = ` ${address}`;
  }
  if (additional) {
    details += ` - Local (${additional})`;
  }

  // Reducing the limit improves the performance significantly. We do not
  // lose the stack frames due to the `captureStackTrace()` function that
  // is called later.
  const tmpLimit = Error.stackTraceLimit;
  if (isErrorStackTraceLimitWritable()) Error.stackTraceLimit = 0;
  // eslint-disable-next-line no-restricted-syntax
  const ex = new Error(`${syscall} ${code}${details}`);
  if (isErrorStackTraceLimitWritable()) Error.stackTraceLimit = tmpLimit;
  ex.errno = err;
  ex.code = code;
  ex.syscall = syscall;
  ex.address = address;
  if (port) {
    ex.port = port;
  }

  return captureLargerStackTrace(ex);
});

function connResetException(msg) {
  // eslint-disable-next-line no-restricted-syntax
  const ex = new Error(msg);
  ex.code = "ECONNRESET";
  return ex;
}

let maxStack_ErrorName;
let maxStack_ErrorMessage;
/**
 * Returns true if `err.name` and `err.message` are equal to engine-specific
 * values indicating max call stack size has been exceeded.
 * "Maximum call stack size exceeded" in V8.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isStackOverflowError(err) {
  if (maxStack_ErrorMessage === undefined) {
    try {
      function overflowStack() {
        overflowStack();
      }
      overflowStack();
    } catch (err) {
      maxStack_ErrorMessage = err.message;
      maxStack_ErrorName = err.name;
    }
  }

  return (
    err &&
    err.name === maxStack_ErrorName &&
    err.message === maxStack_ErrorMessage
  );
}

// Only use this for integers! Decimal numbers do not work with this function.
function addNumericalSeparator(val) {
  let res = "";
  let i = val.length;
  const start = val[0] === "-" ? 1 : 0;
  for (; i >= start + 4; i -= 3) {
    res = `_${String.prototype.slice.call(val, i - 3, i)}${res}`;
  }
  return `${String.prototype.slice.call(val, 0, i)}${res}`;
}

// Used to enhance the stack that will be picked up by the inspector
const kEnhanceStackBeforeInspector = Symbol("kEnhanceStackBeforeInspector");

// These are supposed to be called only on fatal exceptions before
// the process exits.
const fatalExceptionStackEnhancers = {
  beforeInspector(error) {
    if (typeof error[kEnhanceStackBeforeInspector] !== "function") {
      return error.stack;
    }

    try {
      // Set the error.stack here so it gets picked up by the
      // inspector.
      error.stack = error[kEnhanceStackBeforeInspector]();
    } catch {
      // We are just enhancing the error. If it fails, ignore it.
    }
    return error.stack;
  },
  afterInspector(error) {
    const originalStack = error.stack;

    const { inspect } = lazyInternalUtilInspect();

    try {
      return inspect(error, {
        colors: false,
        customInspect: false,
        depth: Math.max(inspect.defaultOptions.depth, 5),
      });
    } catch {
      return originalStack;
    }
  },
};

// Node uses an AbortError that isn't exactly the same as the DOMException
// to make usage of the error in userland and readable-stream easier.
// It is a regular error with `.code` and `.name`.
class AbortError extends Error {
  constructor() {
    super("The operation was aborted");
    this.code = "ABORT_ERR";
    this.name = "AbortError";
  }
}
module.exports = {
  addCodeToName, // Exported for NghttpError
  codes,
  errnoException,
  exceptionWithHostPort,
  getMessage,
  hideStackFrames,
  isErrorStackTraceLimitWritable,
  isStackOverflowError,
  connResetException,
  SystemError,
  AbortError,
  // This is exported only to facilitate testing.
  E,
  kNoOverride,
  prepareStackTrace,
  maybeOverridePrepareStackTrace,
  overrideStackTrace,
  kEnhanceStackBeforeInspector,
  fatalExceptionStackEnhancers,
};

// To declare an error message, use the E(sym, val, def) function above. The sym
// must be an upper case string. The val can be either a function or a string.
// The def must be an error class.
// The return value of the function must be a string.
// Examples:
// E('EXAMPLE_KEY1', 'This is the error value', Error);
// E('EXAMPLE_KEY2', (a, b) => return `${a} ${b}`, RangeError);
//
// Once an error code has been assigned, the code itself MUST NOT change and
// any given error code must never be reused to identify a different error.
//
// Any error code added here should also be added to the documentation
//
// Note: Please try to keep these in alphabetical order
//
// Note: Node.js specific errors must begin with the prefix ERR_
E("ERR_AMBIGUOUS_ARGUMENT", 'The "%s" argument is ambiguous. %s', TypeError);
E("ERR_ARG_NOT_ITERABLE", "%s must be iterable", TypeError);
E("ERR_ASSERTION", "%s", Error);
E("ERR_ASYNC_CALLBACK", "%s must be a function", TypeError);
E("ERR_ASYNC_TYPE", 'Invalid name for async "type": %s', TypeError);
E("ERR_BROTLI_INVALID_PARAM", "%s is not a valid Brotli parameter", RangeError);
E(
  "ERR_BUFFER_OUT_OF_BOUNDS",
  // Using a default argument here is important so the argument is not counted
  // towards `Function#length`.
  (name = undefined) => {
    if (name) {
      return `"${name}" is outside of buffer bounds`;
    }
    return "Attempt to access memory outside buffer bounds";
  },
  RangeError
);
E(
  "ERR_BUFFER_TOO_LARGE",
  "Cannot create a Buffer larger than %s bytes",
  RangeError
);
E("ERR_CANNOT_WATCH_SIGINT", "Cannot watch for SIGINT signals", Error);
E("ERR_CHILD_CLOSED_BEFORE_REPLY", "Child closed before reply received", Error);
E(
  "ERR_CHILD_PROCESS_IPC_REQUIRED",
  "Forked processes must have an IPC channel, missing value 'ipc' in %s",
  Error
);
E(
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  "%s maxBuffer length exceeded",
  RangeError
);
E(
  "ERR_CONSOLE_WRITABLE_STREAM",
  "Console expects a writable stream instance for %s",
  TypeError
);
E("ERR_CONTEXT_NOT_INITIALIZED", "context used is not initialized", Error);
E(
  "ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED",
  "Custom engines not supported by this OpenSSL",
  Error
);
E("ERR_CRYPTO_ECDH_INVALID_FORMAT", "Invalid ECDH format: %s", TypeError);
E(
  "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY",
  "Public key is not valid for specified curve",
  Error
);
E("ERR_CRYPTO_ENGINE_UNKNOWN", 'Engine "%s" was not found', Error);
E(
  "ERR_CRYPTO_FIPS_FORCED",
  "Cannot set FIPS mode, it was forced with --force-fips at startup.",
  Error
);
E(
  "ERR_CRYPTO_FIPS_UNAVAILABLE",
  "Cannot set FIPS mode in a non-FIPS build.",
  Error
);
E("ERR_CRYPTO_HASH_FINALIZED", "Digest already called", Error);
E("ERR_CRYPTO_HASH_UPDATE_FAILED", "Hash update failed", Error);
E("ERR_CRYPTO_INCOMPATIBLE_KEY", "Incompatible %s: %s", Error);
E(
  "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS",
  "The selected key encoding %s %s.",
  Error
);
E("ERR_CRYPTO_INVALID_DIGEST", "Invalid digest: %s", TypeError);
E("ERR_CRYPTO_INVALID_JWK", "Invalid JWK data", TypeError);
E(
  "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
  "Invalid key object type %s, expected %s.",
  TypeError
);
E("ERR_CRYPTO_INVALID_STATE", "Invalid state for operation %s", Error);
E("ERR_CRYPTO_JWK_UNSUPPORTED_CURVE", "Unsupported JWK EC curve: %s.", Error);
E("ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE", "Unsupported JWK Key Type.", Error);
E("ERR_CRYPTO_PBKDF2_ERROR", "PBKDF2 error", Error);
E("ERR_CRYPTO_SCRYPT_INVALID_PARAMETER", "Invalid scrypt parameter", Error);
E("ERR_CRYPTO_SCRYPT_NOT_SUPPORTED", "Scrypt algorithm not supported", Error);
// Switch to TypeError. The current implementation does not seem right.
E("ERR_CRYPTO_SIGN_KEY_REQUIRED", "No key provided to sign", Error);
E("ERR_DEBUGGER_ERROR", "%s", Error);
E("ERR_DEBUGGER_STARTUP_ERROR", "%s", Error);
E("ERR_DIR_CLOSED", "Directory handle was closed", Error);
E(
  "ERR_DIR_CONCURRENT_OPERATION",
  "Cannot do synchronous work on directory handle with concurrent " +
    "asynchronous operations",
  Error
);
E(
  "ERR_DNS_SET_SERVERS_FAILED",
  'c-ares failed to set servers: "%s" [%s]',
  Error
);
E(
  "ERR_DOMAIN_CALLBACK_NOT_AVAILABLE",
  "A callback was registered through " +
    "process.setUncaughtExceptionCaptureCallback(), which is mutually " +
    "exclusive with using the `domain` module",
  Error
);
E(
  "ERR_DOMAIN_CANNOT_SET_UNCAUGHT_EXCEPTION_CAPTURE",
  "The `domain` module is in use, which is mutually exclusive with calling " +
    "process.setUncaughtExceptionCaptureCallback()",
  Error
);
E(
  "ERR_ENCODING_INVALID_ENCODED_DATA",
  function (encoding, ret) {
    this.errno = ret;
    return `The encoded data was not valid for encoding ${encoding}`;
  },
  TypeError
);
E(
  "ERR_ENCODING_NOT_SUPPORTED",
  'The "%s" encoding is not supported',
  RangeError
);
E("ERR_EVAL_ESM_CANNOT_PRINT", "--print cannot be used with ESM input", Error);
E("ERR_EVENT_RECURSION", 'The event "%s" is already being dispatched', Error);
E(
  "ERR_FALSY_VALUE_REJECTION",
  function (reason) {
    this.reason = reason;
    return "Promise was rejected with falsy value";
  },
  Error
);
E(
  "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
  "The feature %s is unavailable on the current platform" +
    ", which is being used to run Node.js",
  TypeError
);
E("ERR_FS_EISDIR", "Path is a directory", SystemError);
E("ERR_FS_FILE_TOO_LARGE", "File size (%s) is greater than 2 GB", RangeError);
E(
  "ERR_FS_INVALID_SYMLINK_TYPE",
  'Symlink type must be one of "dir", "file", or "junction". Received "%s"',
  Error
); // Switch to TypeError. The current implementation does not seem right
E(
  "ERR_HTTP2_ALTSVC_INVALID_ORIGIN",
  "HTTP/2 ALTSVC frames require a valid origin",
  TypeError
);
E(
  "ERR_HTTP2_ALTSVC_LENGTH",
  "HTTP/2 ALTSVC frames are limited to 16382 bytes",
  TypeError
);
E(
  "ERR_HTTP2_CONNECT_AUTHORITY",
  ":authority header is required for CONNECT requests",
  Error
);
E(
  "ERR_HTTP2_CONNECT_PATH",
  "The :path header is forbidden for CONNECT requests",
  Error
);
E(
  "ERR_HTTP2_CONNECT_SCHEME",
  "The :scheme header is forbidden for CONNECT requests",
  Error
);
E(
  "ERR_HTTP2_GOAWAY_SESSION",
  "New streams cannot be created after receiving a GOAWAY",
  Error
);
E(
  "ERR_HTTP2_HEADERS_AFTER_RESPOND",
  "Cannot specify additional headers after response initiated",
  Error
);
E("ERR_HTTP2_HEADERS_SENT", "Response has already been initiated.", Error);
E(
  "ERR_HTTP2_HEADER_SINGLE_VALUE",
  'Header field "%s" must only have a single value',
  TypeError
);
E(
  "ERR_HTTP2_INFO_STATUS_NOT_ALLOWED",
  "Informational status codes cannot be used",
  RangeError
);
E(
  "ERR_HTTP2_INVALID_CONNECTION_HEADERS",
  'HTTP/1 Connection specific headers are forbidden: "%s"',
  TypeError
);
E(
  "ERR_HTTP2_INVALID_HEADER_VALUE",
  'Invalid value "%s" for header "%s"',
  TypeError
);
E(
  "ERR_HTTP2_INVALID_INFO_STATUS",
  "Invalid informational status code: %s",
  RangeError
);
E(
  "ERR_HTTP2_INVALID_ORIGIN",
  "HTTP/2 ORIGIN frames require a valid origin",
  TypeError
);
E(
  "ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH",
  "Packed settings length must be a multiple of six",
  RangeError
);
E(
  "ERR_HTTP2_INVALID_PSEUDOHEADER",
  '"%s" is an invalid pseudoheader or is used incorrectly',
  TypeError
);
E("ERR_HTTP2_INVALID_SESSION", "The session has been destroyed", Error);
E(
  "ERR_HTTP2_INVALID_SETTING_VALUE",
  // Using default arguments here is important so the arguments are not counted
  // towards `Function#length`.
  function (name, actual, min = undefined, max = undefined) {
    this.actual = actual;
    if (min !== undefined) {
      this.min = min;
      this.max = max;
    }
    return `Invalid value for setting "${name}": ${actual}`;
  },
  TypeError,
  RangeError
);
E("ERR_HTTP2_INVALID_STREAM", "The stream has been destroyed", Error);
E(
  "ERR_HTTP2_MAX_PENDING_SETTINGS_ACK",
  "Maximum number of pending settings acknowledgements",
  Error
);
E(
  "ERR_HTTP2_NESTED_PUSH",
  "A push stream cannot initiate another push stream.",
  Error
);
E("ERR_HTTP2_NO_MEM", "Out of memory", Error);
E(
  "ERR_HTTP2_NO_SOCKET_MANIPULATION",
  "HTTP/2 sockets should not be directly manipulated (e.g. read and written)",
  Error
);
E(
  "ERR_HTTP2_ORIGIN_LENGTH",
  "HTTP/2 ORIGIN frames are limited to 16382 bytes",
  TypeError
);
E(
  "ERR_HTTP2_OUT_OF_STREAMS",
  "No stream ID is available because maximum stream ID has been reached",
  Error
);
E(
  "ERR_HTTP2_PAYLOAD_FORBIDDEN",
  "Responses with %s status must not have a payload",
  Error
);
E("ERR_HTTP2_PING_CANCEL", "HTTP2 ping cancelled", Error);
E("ERR_HTTP2_PING_LENGTH", "HTTP2 ping payload must be 8 bytes", RangeError);
E(
  "ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED",
  "Cannot set HTTP/2 pseudo-headers",
  TypeError
);
E("ERR_HTTP2_PUSH_DISABLED", "HTTP/2 client has disabled push streams", Error);
E("ERR_HTTP2_SEND_FILE", "Directories cannot be sent", Error);
E(
  "ERR_HTTP2_SEND_FILE_NOSEEK",
  "Offset or length can only be specified for regular files",
  Error
);
E("ERR_HTTP2_SESSION_ERROR", "Session closed with error code %s", Error);
E("ERR_HTTP2_SETTINGS_CANCEL", "HTTP2 session settings canceled", Error);
E(
  "ERR_HTTP2_SOCKET_BOUND",
  "The socket is already bound to an Http2Session",
  Error
);
E(
  "ERR_HTTP2_SOCKET_UNBOUND",
  "The socket has been disconnected from the Http2Session",
  Error
);
E(
  "ERR_HTTP2_STATUS_101",
  "HTTP status code 101 (Switching Protocols) is forbidden in HTTP/2",
  Error
);
E("ERR_HTTP2_STATUS_INVALID", "Invalid status code: %s", RangeError);
E(
  "ERR_HTTP2_STREAM_CANCEL",
  function (error) {
    let msg = "The pending stream has been canceled";
    if (error) {
      this.cause = error;
      if (typeof error.message === "string")
        msg += ` (caused by: ${error.message})`;
    }
    return msg;
  },
  Error
);
E("ERR_HTTP2_STREAM_ERROR", "Stream closed with error code %s", Error);
E(
  "ERR_HTTP2_STREAM_SELF_DEPENDENCY",
  "A stream cannot depend on itself",
  Error
);
E("ERR_HTTP2_TOO_MANY_INVALID_FRAMES", "Too many invalid HTTP/2 frames", Error);
E(
  "ERR_HTTP2_TRAILERS_ALREADY_SENT",
  "Trailing headers have already been sent",
  Error
);
E(
  "ERR_HTTP2_TRAILERS_NOT_READY",
  "Trailing headers cannot be sent until after the wantTrailers event is " +
    "emitted",
  Error
);
E("ERR_HTTP2_UNSUPPORTED_PROTOCOL", 'protocol "%s" is unsupported.', Error);
E(
  "ERR_HTTP_HEADERS_SENT",
  "Cannot %s headers after they are sent to the client",
  Error
);
E(
  "ERR_HTTP_INVALID_HEADER_VALUE",
  'Invalid value "%s" for header "%s"',
  TypeError
);
E("ERR_HTTP_INVALID_STATUS_CODE", "Invalid status code: %s", RangeError);
E("ERR_HTTP_REQUEST_TIMEOUT", "Request timeout", Error);
E(
  "ERR_HTTP_SOCKET_ENCODING",
  "Changing the socket encoding is not allowed per RFC7230 Section 3.",
  Error
);
E(
  "ERR_HTTP_TRAILER_INVALID",
  "Trailers are invalid with this transfer encoding",
  Error
);
E("ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor", TypeError);
E(
  "ERR_INCOMPATIBLE_OPTION_PAIR",
  'Option "%s" cannot be used in combination with option "%s"',
  TypeError
);
E(
  "ERR_INPUT_TYPE_NOT_ALLOWED",
  "--input-type can only be used with string " +
    "input via --eval, --print, or STDIN",
  Error
);
E(
  "ERR_INSPECTOR_ALREADY_ACTIVATED",
  "Inspector is already activated. Close it with inspector.close() " +
    "before activating it again.",
  Error
);
E("ERR_INSPECTOR_ALREADY_CONNECTED", "%s is already connected", Error);
E("ERR_INSPECTOR_CLOSED", "Session was closed", Error);
E("ERR_INSPECTOR_COMMAND", "Inspector error %d: %s", Error);
E("ERR_INSPECTOR_NOT_ACTIVE", "Inspector is not active", Error);
E("ERR_INSPECTOR_NOT_AVAILABLE", "Inspector is not available", Error);
E("ERR_INSPECTOR_NOT_CONNECTED", "Session is not connected", Error);
E("ERR_INSPECTOR_NOT_WORKER", "Current thread is not a worker", Error);
E(
  "ERR_INTERNAL_ASSERTION",
  (message) => {
    const suffix =
      "This is caused by either a bug in Node.js " +
      "or incorrect usage of Node.js internals.\n" +
      "Please open an issue with this stack trace at " +
      "https://github.com/nodejs/node/issues\n";
    return message === undefined ? suffix : `${message}\n${suffix}`;
  },
  Error
);
E(
  "ERR_INVALID_ADDRESS_FAMILY",
  function (addressType, host, port) {
    this.host = host;
    this.port = port;
    return `Invalid address family: ${addressType} ${host}:${port}`;
  },
  RangeError
);
E(
  "ERR_INVALID_ARG_TYPE",
  (name, expected, actual) => {
    assert(typeof name === "string", "'name' must be a string");
    if (!Array.isArray(expected)) {
      expected = [expected];
    }

    let msg = "The ";
    if (String.prototype.endsWith.call(name, " argument")) {
      // For cases like 'first argument'
      msg += `${name} `;
    } else {
      const type = String.prototype.includes.call(name, ".")
        ? "property"
        : "argument";
      msg += `"${name}" ${type} `;
    }
    msg += "must be ";

    const types = [];
    const instances = [];
    const other = [];

    for (const value of expected) {
      assert(
        typeof value === "string",
        "All expected entries have to be of type string"
      );
      if (Array.prototype.includes.call(kTypes, value)) {
        Array.prototype.push.call(
          types,
          String.prototype.toLowerCase.call(value)
        );
      } else if (RegExp.prototype.test.call(classRegExp, value)) {
        Array.prototype.push.call(instances, value);
      } else {
        assert(
          value !== "object",
          'The value "object" should be written as "Object"'
        );
        Array.prototype.push.call(other, value);
      }
    }

    // Special handle `object` in case other instances are allowed to outline
    // the differences between each other.
    if (instances.length > 0) {
      const pos = Array.prototype.indexOf.call(types, "object");
      if (pos !== -1) {
        Array.prototype.splice.call(types, pos, 1);
        Array.prototype.push.call(instances, "Object");
      }
    }

    if (types.length > 0) {
      if (types.length > 2) {
        const last = Array.prototype.pop.call(types);
        msg += `one of type ${Array.prototype.join.call(
          types,
          ", "
        )}, or ${last}`;
      } else if (types.length === 2) {
        msg += `one of type ${types[0]} or ${types[1]}`;
      } else {
        msg += `of type ${types[0]}`;
      }
      if (instances.length > 0 || other.length > 0) msg += " or ";
    }

    if (instances.length > 0) {
      if (instances.length > 2) {
        const last = Array.prototype.pop.call(instances);
        msg += `an instance of ${Array.prototype.join.call(
          instances,
          ", "
        )}, or ${last}`;
      } else {
        msg += `an instance of ${instances[0]}`;
        if (instances.length === 2) {
          msg += ` or ${instances[1]}`;
        }
      }
      if (other.length > 0) msg += " or ";
    }

    if (other.length > 0) {
      if (other.length > 2) {
        const last = Array.prototype.pop.call(other);
        msg += `one of ${Array.prototype.join.call(other, ", ")}, or ${last}`;
      } else if (other.length === 2) {
        msg += `one of ${other[0]} or ${other[1]}`;
      } else {
        if (String.prototype.toLowerCase.call(other[0]) !== other[0])
          msg += "an ";
        msg += `${other[0]}`;
      }
    }

    if (actual == null) {
      msg += `. Received ${actual}`;
    } else if (typeof actual === "function" && actual.name) {
      msg += `. Received function ${actual.name}`;
    } else if (typeof actual === "object") {
      if (actual.constructor && actual.constructor.name) {
        msg += `. Received an instance of ${actual.constructor.name}`;
      } else {
        const inspected = lazyInternalUtilInspect().inspect(actual, {
          depth: -1,
        });
        msg += `. Received ${inspected}`;
      }
    } else {
      let inspected = lazyInternalUtilInspect().inspect(actual, {
        colors: false,
      });
      if (inspected.length > 25)
        inspected = `${String.prototype.slice.call(inspected, 0, 25)}...`;
      msg += `. Received type ${typeof actual} (${inspected})`;
    }
    return msg;
  },
  TypeError
);
E(
  "ERR_INVALID_ARG_VALUE",
  (name, value, reason = "is invalid") => {
    let inspected = lazyInternalUtilInspect().inspect(value);
    if (inspected.length > 128) {
      inspected = `${String.prototype.slice.call(inspected, 0, 128)}...`;
    }
    const type = String.prototype.includes.call(name, ".")
      ? "property"
      : "argument";
    return `The ${type} '${name}' ${reason}. Received ${inspected}`;
  },
  TypeError,
  RangeError
);
E("ERR_INVALID_ASYNC_ID", "Invalid %s value: %s", RangeError);
E(
  "ERR_INVALID_BUFFER_SIZE",
  "Buffer size must be a multiple of %s",
  RangeError
);
E(
  "ERR_INVALID_CALLBACK",
  "Callback must be a function. Received %O",
  TypeError
);
E(
  "ERR_INVALID_CHAR",
  // Using a default argument here is important so the argument is not counted
  // towards `Function#length`.
  (name, field = undefined) => {
    let msg = `Invalid character in ${name}`;
    if (field !== undefined) {
      msg += ` ["${field}"]`;
    }
    return msg;
  },
  TypeError
);
E(
  "ERR_INVALID_CURSOR_POS",
  "Cannot set cursor row without setting its column",
  TypeError
);
E("ERR_INVALID_FD", '"fd" must be a positive integer: %s', RangeError);
E("ERR_INVALID_FD_TYPE", "Unsupported fd type: %s", TypeError);
E(
  "ERR_INVALID_FILE_URL_HOST",
  'File URL host must be "localhost" or empty on %s',
  TypeError
);
E("ERR_INVALID_FILE_URL_PATH", "File URL path %s", TypeError);
E("ERR_INVALID_HANDLE_TYPE", "This handle type cannot be sent", TypeError);
E("ERR_INVALID_HTTP_TOKEN", '%s must be a valid HTTP token ["%s"]', TypeError);
E("ERR_INVALID_IP_ADDRESS", "Invalid IP address: %s", TypeError);
E(
  "ERR_INVALID_MODULE_SPECIFIER",
  (request, reason, base = undefined) => {
    return `Invalid module "${request}" ${reason}${
      base ? ` imported from ${base}` : ""
    }`;
  },
  TypeError
);
E(
  "ERR_INVALID_PACKAGE_CONFIG",
  (path, base, message) => {
    return `Invalid package config ${path}${
      base ? ` while importing ${base}` : ""
    }${message ? `. ${message}` : ""}`;
  },
  Error
);
E(
  "ERR_INVALID_PACKAGE_TARGET",
  (pkgPath, key, target, isImport = false, base = undefined) => {
    const relError =
      typeof target === "string" &&
      !isImport &&
      target.length &&
      !String.prototype.startsWith.call(target, "./");
    if (key === ".") {
      assert(isImport === false);
      return (
        `Invalid "exports" main target ${JSON.stringify(target)} defined ` +
        `in the package config ${pkgPath}package.json${
          base ? ` imported from ${base}` : ""
        }${relError ? '; targets must start with "./"' : ""}`
      );
    }
    return `Invalid "${
      isImport ? "imports" : "exports"
    }" target ${JSON.stringify(
      target
    )} defined for '${key}' in the package config ${pkgPath}package.json${
      base ? ` imported from ${base}` : ""
    }${relError ? '; targets must start with "./"' : ""}`;
  },
  Error
);
E(
  "ERR_INVALID_PERFORMANCE_MARK",
  'The "%s" performance mark has not been set',
  Error
);
E(
  "ERR_INVALID_PROTOCOL",
  'Protocol "%s" not supported. Expected "%s"',
  TypeError
);
E(
  "ERR_INVALID_REPL_EVAL_CONFIG",
  'Cannot specify both "breakEvalOnSigint" and "eval" for REPL',
  TypeError
);
E("ERR_INVALID_REPL_INPUT", "%s", TypeError);
E(
  "ERR_INVALID_RETURN_PROPERTY",
  (input, name, prop, value) => {
    return (
      `Expected a valid ${input} to be returned for the "${prop}" from the` +
      ` "${name}" function but got ${value}.`
    );
  },
  TypeError
);
E(
  "ERR_INVALID_RETURN_PROPERTY_VALUE",
  (input, name, prop, value) => {
    let type;
    if (value && value.constructor && value.constructor.name) {
      type = `instance of ${value.constructor.name}`;
    } else {
      type = `type ${typeof value}`;
    }
    return (
      `Expected ${input} to be returned for the "${prop}" from the` +
      ` "${name}" function but got ${type}.`
    );
  },
  TypeError
);
E(
  "ERR_INVALID_RETURN_VALUE",
  (input, name, value) => {
    let type;
    if (value && value.constructor && value.constructor.name) {
      type = `instance of ${value.constructor.name}`;
    } else {
      type = `type ${typeof value}`;
    }
    return (
      `Expected ${input} to be returned from the "${name}"` +
      ` function but got ${type}.`
    );
  },
  TypeError,
  RangeError
);
E("ERR_INVALID_STATE", "Invalid state: %s", Error, TypeError, RangeError);
E(
  "ERR_INVALID_SYNC_FORK_INPUT",
  "Asynchronous forks do not support " +
    "Buffer, TypedArray, DataView or string input: %s",
  TypeError
);
E("ERR_INVALID_THIS", 'Value of "this" must be of type %s', TypeError);
E("ERR_INVALID_TUPLE", "%s must be an iterable %s tuple", TypeError);
E("ERR_INVALID_URI", "URI malformed", URIError);
E(
  "ERR_INVALID_URL",
  function (input) {
    this.input = input;
    // Don't include URL in message.
    // (See https://github.com/nodejs/node/pull/38614)
    return "Invalid URL";
  },
  TypeError
);
E(
  "ERR_INVALID_URL_SCHEME",
  (expected) => {
    if (typeof expected === "string") expected = [expected];
    assert(expected.length <= 2);
    const res =
      expected.length === 2
        ? `one of scheme ${expected[0]} or ${expected[1]}`
        : `of scheme ${expected[0]}`;
    return `The URL must be ${res}`;
  },
  TypeError
);
E("ERR_IPC_CHANNEL_CLOSED", "Channel closed", Error);
E("ERR_IPC_DISCONNECTED", "IPC channel is already disconnected", Error);
E("ERR_IPC_ONE_PIPE", "Child process can have only one IPC pipe", Error);
E("ERR_IPC_SYNC_FORK", "IPC cannot be used with synchronous forks", Error);
E(
  "ERR_MANIFEST_ASSERT_INTEGRITY",
  (moduleURL, realIntegrities) => {
    let msg = `The content of "${moduleURL}" does not match the expected integrity.`;
    if (realIntegrities.size) {
      const sri = Array.prototype.join.call(
        Array.from(
          realIntegrities.entries(),
          ({ 0: alg, 1: dgs }) => `${alg}-${dgs}`
        ),
        " "
      );
      msg += ` Integrities found are: ${sri}`;
    } else {
      msg += " The resource was not found in the policy.";
    }
    return msg;
  },
  Error
);
E(
  "ERR_MANIFEST_DEPENDENCY_MISSING",
  "Manifest resource %s does not list %s as a dependency specifier for " +
    "conditions: %s",
  Error
);
E(
  "ERR_MANIFEST_INTEGRITY_MISMATCH",
  "Manifest resource %s has multiple entries but integrity lists do not match",
  SyntaxError
);
E(
  "ERR_MANIFEST_INVALID_RESOURCE_FIELD",
  "Manifest resource %s has invalid property value for %s",
  TypeError
);
E("ERR_MANIFEST_TDZ", "Manifest initialization has not yet run", Error);
E(
  "ERR_MANIFEST_UNKNOWN_ONERROR",
  'Manifest specified unknown error behavior "%s".',
  SyntaxError
);
E("ERR_METHOD_NOT_IMPLEMENTED", "The %s method is not implemented", Error);
E(
  "ERR_MISSING_ARGS",
  (...args) => {
    assert(args.length > 0, "At least one arg needs to be specified");
    let msg = "The ";
    const len = args.length;
    const wrap = (a) => `"${a}"`;
    args = Array.prototype.map.call(args, (a) =>
      Array.isArray(a)
        ? Array.prototype.join.call(Array.prototype.map.call(a, wrap), " or ")
        : wrap(a)
    );
    switch (len) {
      case 1:
        msg += `${args[0]} argument`;
        break;
      case 2:
        msg += `${args[0]} and ${args[1]} arguments`;
        break;
      default:
        msg += Array.prototype.join.call(
          Array.prototype.slice.call(args, 0, len - 1),
          ", "
        );
        msg += `, and ${args[len - 1]} arguments`;
        break;
    }
    return `${msg} must be specified`;
  },
  TypeError
);
E("ERR_MISSING_OPTION", "%s is required", TypeError);
E(
  "ERR_MODULE_NOT_FOUND",
  (path, base, type = "package") => {
    return `Cannot find ${type} '${path}' imported from ${base}`;
  },
  Error
);
E("ERR_MULTIPLE_CALLBACK", "Callback called multiple times", Error);
E("ERR_NAPI_CONS_FUNCTION", "Constructor must be a function", TypeError);
E(
  "ERR_NAPI_INVALID_DATAVIEW_ARGS",
  "byte_offset + byte_length should be less than or equal to the size in " +
    "bytes of the array passed in",
  RangeError
);
E(
  "ERR_NAPI_INVALID_TYPEDARRAY_ALIGNMENT",
  "start offset of %s should be a multiple of %s",
  RangeError
);
E(
  "ERR_NAPI_INVALID_TYPEDARRAY_LENGTH",
  "Invalid typed array length",
  RangeError
);
E(
  "ERR_NO_CRYPTO",
  "Node.js is not compiled with OpenSSL crypto support",
  Error
);
E(
  "ERR_NO_ICU",
  "%s is not supported on Node.js compiled without ICU",
  TypeError
);
E("ERR_OPERATION_FAILED", "Operation failed: %s", Error, TypeError);
E(
  "ERR_OUT_OF_RANGE",
  (str, range, input, replaceDefaultBoolean = false) => {
    assert(range, 'Missing "range" argument');
    let msg = replaceDefaultBoolean
      ? str
      : `The value of "${str}" is out of range.`;
    let received;
    if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) {
      received = addNumericalSeparator(String(input));
    } else if (typeof input === "bigint") {
      received = String(input);
      if (input > 2n ** 32n || input < -(2n ** 32n)) {
        received = addNumericalSeparator(received);
      }
      received += "n";
    } else {
      received = lazyInternalUtilInspect().inspect(input);
    }
    msg += ` It must be ${range}. Received ${received}`;
    return msg;
  },
  RangeError
);
E(
  "ERR_PACKAGE_IMPORT_NOT_DEFINED",
  (specifier, packagePath, base) => {
    return `Package import specifier "${specifier}" is not defined${
      packagePath ? ` in package ${packagePath}package.json` : ""
    } imported from ${base}`;
  },
  TypeError
);
E(
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  (pkgPath, subpath, base = undefined) => {
    if (subpath === ".")
      return `No "exports" main defined in ${pkgPath}package.json${
        base ? ` imported from ${base}` : ""
      }`;
    return `Package subpath '${subpath}' is not defined by "exports" in ${pkgPath}package.json${
      base ? ` imported from ${base}` : ""
    }`;
  },
  Error
);
E(
  "ERR_PERFORMANCE_INVALID_TIMESTAMP",
  "%d is not a valid timestamp",
  TypeError
);
E("ERR_PERFORMANCE_MEASURE_INVALID_OPTIONS", "%s", TypeError);
E(
  "ERR_REQUIRE_ESM",
  (filename, parentPath = null, packageJsonPath = null) => {
    let msg = `Must use import to load ES Module: ${filename}`;
    if (parentPath && packageJsonPath) {
      const path = require("path");
      const basename =
        path.basename(filename) === path.basename(parentPath)
          ? filename
          : path.basename(filename);
      msg +=
        "\nrequire() of ES modules is not supported.\nrequire() of " +
        `${filename} from ${parentPath} ` +
        "is an ES module file as it is a .js file whose nearest parent " +
        'package.json contains "type": "module" which defines all .js ' +
        "files in that package scope as ES modules.\nInstead rename " +
        `${basename} to end in .cjs, change the requiring code to use ` +
        'import(), or remove "type": "module" from ' +
        `${packageJsonPath}.\n`;
      return msg;
    }
    return msg;
  },
  Error
);
E(
  "ERR_SCRIPT_EXECUTION_INTERRUPTED",
  "Script execution was interrupted by `SIGINT`",
  Error
);
E(
  "ERR_SERVER_ALREADY_LISTEN",
  "Listen method has been called more than once without closing.",
  Error
);
E("ERR_SERVER_NOT_RUNNING", "Server is not running.", Error);
E("ERR_SOCKET_ALREADY_BOUND", "Socket is already bound", Error);
E(
  "ERR_SOCKET_BAD_BUFFER_SIZE",
  "Buffer size must be a positive integer",
  TypeError
);
E(
  "ERR_SOCKET_BAD_PORT",
  (name, port, allowZero = true) => {
    assert(
      typeof allowZero === "boolean",
      "The 'allowZero' argument must be of type boolean."
    );
    const operator = allowZero ? ">=" : ">";
    return `${name} should be ${operator} 0 and < 65536. Received ${port}.`;
  },
  RangeError
);
E(
  "ERR_SOCKET_BAD_TYPE",
  "Bad socket type specified. Valid types are: udp4, udp6",
  TypeError
);
E("ERR_SOCKET_BUFFER_SIZE", "Could not get or set buffer size", SystemError);
E("ERR_SOCKET_CLOSED", "Socket is closed", Error);
E("ERR_SOCKET_DGRAM_IS_CONNECTED", "Already connected", Error);
E("ERR_SOCKET_DGRAM_NOT_CONNECTED", "Not connected", Error);
E("ERR_SOCKET_DGRAM_NOT_RUNNING", "Not running", Error);
E(
  "ERR_SRI_PARSE",
  "Subresource Integrity string %j had an unexpected %j at position %d",
  SyntaxError
);
E(
  "ERR_STREAM_ALREADY_FINISHED",
  "Cannot call %s after a stream was finished",
  Error
);
E("ERR_STREAM_CANNOT_PIPE", "Cannot pipe, not readable", Error);
E("ERR_STREAM_DESTROYED", "Cannot call %s after a stream was destroyed", Error);
E("ERR_STREAM_NULL_VALUES", "May not write null values to stream", TypeError);
E("ERR_STREAM_PREMATURE_CLOSE", "Premature close", Error);
E("ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF", Error);
E(
  "ERR_STREAM_UNSHIFT_AFTER_END_EVENT",
  "stream.unshift() after end event",
  Error
);
E("ERR_STREAM_WRAP", "Stream has StringDecoder set or is in objectMode", Error);
E("ERR_STREAM_WRITE_AFTER_END", "write after end", Error);
E("ERR_SYNTHETIC", "JavaScript Callstack", Error);
E("ERR_SYSTEM_ERROR", "A system error occurred", SystemError);
E(
  "ERR_TLS_CERT_ALTNAME_INVALID",
  function (reason, host, cert) {
    this.reason = reason;
    this.host = host;
    this.cert = cert;
    return `Hostname/IP does not match certificate's altnames: ${reason}`;
  },
  Error
);
E("ERR_TLS_DH_PARAM_SIZE", "DH parameter size %s is less than 2048", Error);
E("ERR_TLS_HANDSHAKE_TIMEOUT", "TLS handshake timeout", Error);
E("ERR_TLS_INVALID_CONTEXT", "%s must be a SecureContext", TypeError);
E(
  "ERR_TLS_INVALID_PROTOCOL_VERSION",
  "%j is not a valid %s TLS protocol version",
  TypeError
);
E(
  "ERR_TLS_INVALID_STATE",
  "TLS socket connection must be securely established",
  Error
);
E(
  "ERR_TLS_PROTOCOL_VERSION_CONFLICT",
  "TLS protocol version %j conflicts with secureProtocol %j",
  TypeError
);
E(
  "ERR_TLS_RENEGOTIATION_DISABLED",
  "TLS session renegotiation disabled for this socket",
  Error
);

// This should probably be a `TypeError`.
E(
  "ERR_TLS_REQUIRED_SERVER_NAME",
  '"servername" is required parameter for Server.addContext',
  Error
);
E("ERR_TLS_SESSION_ATTACK", "TLS session renegotiation attack detected", Error);
E(
  "ERR_TLS_SNI_FROM_SERVER",
  "Cannot issue SNI from a TLS server-side socket",
  Error
);
E(
  "ERR_TRACE_EVENTS_CATEGORY_REQUIRED",
  "At least one category is required",
  TypeError
);
E("ERR_TRACE_EVENTS_UNAVAILABLE", "Trace events are unavailable", Error);

// This should probably be a `RangeError`.
E("ERR_TTY_INIT_FAILED", "TTY initialization failed", SystemError);
E(
  "ERR_UNAVAILABLE_DURING_EXIT",
  "Cannot call function in process exit " + "handler",
  Error
);
E(
  "ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET",
  "`process.setupUncaughtExceptionCapture()` was called while a capture " +
    "callback was already active",
  Error
);
E("ERR_UNESCAPED_CHARACTERS", "%s contains unescaped characters", TypeError);
E(
  "ERR_UNHANDLED_ERROR",
  // Using a default argument here is important so the argument is not counted
  // towards `Function#length`.
  (err = undefined) => {
    const msg = "Unhandled error.";
    if (err === undefined) return msg;
    return `${msg} (${err})`;
  },
  Error
);
E("ERR_UNKNOWN_BUILTIN_MODULE", "No such built-in module: %s", Error);
E("ERR_UNKNOWN_CREDENTIAL", "%s identifier does not exist: %s", Error);
E("ERR_UNKNOWN_ENCODING", "Unknown encoding: %s", TypeError);
E(
  "ERR_UNKNOWN_FILE_EXTENSION",
  'Unknown file extension "%s" for %s',
  TypeError
);
E("ERR_UNKNOWN_MODULE_FORMAT", "Unknown module format: %s", RangeError);
E("ERR_UNKNOWN_SIGNAL", "Unknown signal: %s", TypeError);
E(
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "Directory import '%s' is not supported " +
    "resolving ES modules imported from %s",
  Error
);
E(
  "ERR_UNSUPPORTED_ESM_URL_SCHEME",
  (url) => {
    let msg = "Only file and data URLs are supported by the default ESM loader";
    msg += `. Received protocol '${url.protocol}'`;
    return msg;
  },
  Error
);

// This should probably be a `TypeError`.
E(
  "ERR_VALID_PERFORMANCE_ENTRY_TYPE",
  "At least one valid performance entry type is required",
  Error
);
E(
  "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
  "A dynamic import callback was not specified.",
  TypeError
);
E("ERR_VM_MODULE_ALREADY_LINKED", "Module has already been linked", Error);
E(
  "ERR_VM_MODULE_CANNOT_CREATE_CACHED_DATA",
  "Cached data cannot be created for a module which has been evaluated",
  Error
);
E(
  "ERR_VM_MODULE_DIFFERENT_CONTEXT",
  "Linked modules must use the same context",
  Error
);
E(
  "ERR_VM_MODULE_LINKING_ERRORED",
  "Linking has already failed for the provided module",
  Error
);
E(
  "ERR_VM_MODULE_NOT_MODULE",
  "Provided module is not an instance of Module",
  Error
);
E("ERR_VM_MODULE_STATUS", "Module status %s", Error);
E("ERR_WASI_ALREADY_STARTED", "WASI instance has already started", Error);
E("ERR_WORKER_INIT_FAILED", "Worker initialization failure: %s", Error);
E(
  "ERR_WORKER_INVALID_EXEC_ARGV",
  (errors, msg = "invalid execArgv flags") =>
    `Initiated Worker with ${msg}: ${Array.prototype.join.call(errors, ", ")}`,
  Error
);
E("ERR_WORKER_NOT_RUNNING", "Worker instance not running", Error);
E(
  "ERR_WORKER_OUT_OF_MEMORY",
  "Worker terminated due to reaching memory limit: %s",
  Error
);
E(
  "ERR_WORKER_PATH",
  (filename) =>
    "The worker script or module filename must be an absolute path or a " +
    "relative path starting with './' or '../'." +
    (String.prototype.startsWith.call(filename, "file://")
      ? " Wrap file:// URLs with `new URL`."
      : "") +
    (String.prototype.startsWith.call(filename, "data:text/javascript")
      ? " Wrap data: URLs with `new URL`."
      : "") +
    ` Received "${filename}"`,
  TypeError
);
E(
  "ERR_WORKER_UNSERIALIZABLE_ERROR",
  "Serializing an uncaught exception failed",
  Error
);
E(
  "ERR_WORKER_UNSUPPORTED_EXTENSION",
  'The worker script extension must be ".js", ".mjs", or ".cjs". Received "%s"',
  TypeError
);
E(
  "ERR_WORKER_UNSUPPORTED_OPERATION",
  "%s is not supported in workers",
  TypeError
);
E("ERR_ZLIB_INITIALIZATION_FAILED", "Initialization failed", Error);
