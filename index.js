import { app, ipcMain, session, net, shell, dialog, nativeImage, BrowserWindow } from "electron";
import fixPath from "fix-path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readdirSync, statSync, createReadStream, existsSync, readFileSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, createWriteStream, promises } from "node:fs";
import { unlink, readdir, mkdir, rm, rename, stat, chmod } from "node:fs/promises";
import { join, dirname, extname, resolve, isAbsolute, relative, basename, sep } from "node:path";
import { query, deleteSession } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { spawnSync, spawn } from "node:child_process";
import Database from "better-sqlite3";
import * as pty from "node-pty";
import { parse, TomlError } from "smol-toml";
import ignore from "ignore";
import simpleGit from "simple-git";
import { Buffer as Buffer$1 } from "node:buffer";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const is = {
  dev: !app.isPackaged
};
({
  isWindows: process.platform === "win32",
  isMacOS: process.platform === "darwin",
  isLinux: process.platform === "linux"
});
function log$l(level, domain, msg, ...args) {
  const prefix = `[${domain}]`;
  const fn = level === "debug" ? console.debug : level === "warn" ? console.warn : level === "error" ? console.error : console.info;
  fn(prefix, msg, ...args);
}
const logger = {
  domain(name) {
    return {
      debug: (msg, ...args) => log$l("debug", name, msg, ...args),
      info: (msg, ...args) => log$l("info", name, msg, ...args),
      warn: (msg, ...args) => log$l("warn", name, msg, ...args),
      error: (msg, ...args) => log$l("error", name, msg, ...args)
    };
  }
};
class BackendError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "BackendError";
  }
}
const CODEX_CAPABILITIES = {
  supportsInterrupt: true,
  supportsApproval: true,
  supportsSteer: true,
  supportsThreadFork: true,
  supportsModelSelection: true,
  supportsEffort: true,
  supportsPermissionMode: true,
  supportedPermissionModes: ["default", "acceptEdits", "bypassPermissions"],
  supportedEfforts: ["low", "medium", "high"],
  supportsHotSwap: false,
  chat: {
    subAgents: false,
    compact: true,
    planMode: true,
    webTools: true,
    blockTypes: [
      "text",
      "reasoning",
      "tool_call",
      "context",
      "compact_divider",
      "plan",
      "codex_user_input",
      "codex_activity"
    ]
  }
};
const CLAUDE_CAPABILITIES = {
  supportsInterrupt: true,
  supportsApproval: true,
  supportsSteer: true,
  supportsThreadFork: false,
  supportsModelSelection: true,
  supportsEffort: true,
  supportsPermissionMode: true,
  supportedPermissionModes: [
    "default",
    "acceptEdits",
    "auto",
    "plan",
    "dontAsk",
    "bypassPermissions"
  ],
  supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
  supportsHotSwap: true,
  chat: {
    subAgents: true,
    compact: true,
    planMode: true,
    webTools: true,
    blockTypes: ["text", "reasoning", "tool_call", "context", "compact_divider"]
  }
};
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
const ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
const getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};
const ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
class ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
}
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};
const errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
let overrideErrorMap = errorMap;
function getErrorMap() {
  return overrideErrorMap;
}
const makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
function addIssueToContext(ctx2, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx2.data,
    path: ctx2.path,
    errorMaps: [
      ctx2.common.contextualErrorMap,
      // contextual error map is first priority
      ctx2.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === errorMap ? void 0 : errorMap
      // then global default map
    ].filter((x) => !!x)
  });
  ctx2.common.issues.push(issue);
}
class ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
}
const INVALID = Object.freeze({
  status: "aborted"
});
const DIRTY = (value) => ({ status: "dirty", value });
const OK = (value) => ({ status: "valid", value });
const isAborted = (x) => x.status === "aborted";
const isDirty = (x) => x.status === "dirty";
const isValid = (x) => x.status === "valid";
const isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));
class ParseInputLazyPath {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
}
const handleResult = (ctx2, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx2.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx2.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx2) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx2.defaultError };
    }
    if (typeof ctx2.data === "undefined") {
      return { message: message ?? required_error ?? ctx2.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx2.defaultError };
    return { message: message ?? invalid_type_error ?? ctx2.defaultError };
  };
  return { errorMap: customMap, description };
}
class ZodType {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx2) {
    return ctx2 || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx2 = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx2.path, parent: ctx2 });
    return handleResult(ctx2, result);
  }
  "~validate"(data) {
    const ctx2 = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx2 });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx2.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx2.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx2 }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx2.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx2 = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx2.path, parent: ctx2 });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx2, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx2) => {
      const result = check(val);
      const setError = () => ctx2.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx2) => {
      if (!check(val)) {
        ctx2.addIssue(typeof refinementData === "function" ? refinementData(val, ctx2) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
}
const cuidRegex = /^c[^\s-]{8,}$/i;
const cuid2Regex = /^[0-9a-z]+$/;
const ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
const nanoidRegex = /^[a-z0-9_-]{21}$/i;
const jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
const durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
const emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
const _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
let emojiRegex;
const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
const ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
const base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
const base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
const dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
const dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
class ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx3 = this._getOrReturnCtx(input);
      addIssueToContext(ctx3, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx3.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx2 = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          if (tooBig) {
            addIssueToContext(ctx2, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx2, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
}
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
class ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx3 = this._getOrReturnCtx(input);
      addIssueToContext(ctx3, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx3.parsedType
      });
      return INVALID;
    }
    let ctx2 = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
}
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
class ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx2 = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx2 = this._getOrReturnCtx(input);
    addIssueToContext(ctx2, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx2.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
}
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
class ZodBoolean extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
class ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx3 = this._getOrReturnCtx(input);
      addIssueToContext(ctx3, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx3.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx3 = this._getOrReturnCtx(input);
      addIssueToContext(ctx3, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx2 = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx2 = this._getOrReturnCtx(input, ctx2);
          addIssueToContext(ctx2, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
}
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
class ZodSymbol extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
class ZodUndefined extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
class ZodNull extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
class ZodAny extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
class ZodUnknown extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
class ZodNever extends ZodType {
  _parse(input) {
    const ctx2 = this._getOrReturnCtx(input);
    addIssueToContext(ctx2, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx2.parsedType
    });
    return INVALID;
  }
}
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
class ZodVoid extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
class ZodArray extends ZodType {
  _parse(input) {
    const { ctx: ctx2, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx2.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx2.data.length > def.exactLength.value;
      const tooSmall = ctx2.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx2, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx2.data.length < def.minLength.value) {
        addIssueToContext(ctx2, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx2.data.length > def.maxLength.value) {
        addIssueToContext(ctx2, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx2.common.async) {
      return Promise.all([...ctx2.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx2, item, ctx2.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx2.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx2, item, ctx2.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
class ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx3 = this._getOrReturnCtx(input);
      addIssueToContext(ctx3, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx3.parsedType
      });
      return INVALID;
    }
    const { status, ctx: ctx2 } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx2.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx2.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx2, value, ctx2.path, key)),
        alwaysSet: key in ctx2.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx2.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx2, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") ;
      else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx2.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx2, value, ctx2.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx2.data
        });
      }
    }
    if (ctx2.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx2) => {
          const defaultError = this._def.errorMap?.(issue, ctx2).message ?? ctx2.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
}
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
class ZodUnion extends ZodType {
  _parse(input) {
    const { ctx: ctx2 } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx2.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx2.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx2,
          common: {
            ...ctx2.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx2.data,
            path: ctx2.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx2,
          common: {
            ...ctx2.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx2.data,
          path: ctx2.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx2.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
}
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
const getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
class ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx: ctx2 } = this._processInputParams(input);
    if (ctx2.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx2.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx2.common.async) {
      return option._parseAsync({
        data: ctx2.data,
        path: ctx2.path,
        parent: ctx2
      });
    } else {
      return option._parseSync({
        data: ctx2.data,
        path: ctx2.path,
        parent: ctx2
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
}
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
class ZodIntersection extends ZodType {
  _parse(input) {
    const { status, ctx: ctx2 } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx2, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx2.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx2.data,
          path: ctx2.path,
          parent: ctx2
        }),
        this._def.right._parseAsync({
          data: ctx2.data,
          path: ctx2.path,
          parent: ctx2
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx2.data,
        path: ctx2.path,
        parent: ctx2
      }), this._def.right._parseSync({
        data: ctx2.data,
        path: ctx2.path,
        parent: ctx2
      }));
    }
  }
}
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
class ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx: ctx2 } = this._processInputParams(input);
    if (ctx2.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (ctx2.data.length < this._def.items.length) {
      addIssueToContext(ctx2, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx2.data.length > this._def.items.length) {
      addIssueToContext(ctx2, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx2.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx2, item, ctx2.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx2.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new ZodTuple({
      ...this._def,
      rest
    });
  }
}
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
class ZodMap extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx: ctx2 } = this._processInputParams(input);
    if (ctx2.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx2.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx2, key, ctx2.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx2, value, ctx2.path, [index, "value"]))
      };
    });
    if (ctx2.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
}
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
class ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx: ctx2 } = this._processInputParams(input);
    if (ctx2.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx2.data.size < def.minSize.value) {
        addIssueToContext(ctx2, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx2.data.size > def.maxSize.value) {
        addIssueToContext(ctx2, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx2.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx2, item, ctx2.path, i)));
    if (ctx2.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
class ZodLazy extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx: ctx2 } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx2.data, path: ctx2.path, parent: ctx2 });
  }
}
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
class ZodLiteral extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        received: ctx2.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
}
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
class ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx2 = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx2, {
        expected: util.joinValues(expectedValues),
        received: ctx2.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx2 = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx2, {
        received: ctx2.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
}
ZodEnum.create = createZodEnum;
class ZodNativeEnum extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx2 = this._getOrReturnCtx(input);
    if (ctx2.parsedType !== ZodParsedType.string && ctx2.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx2, {
        expected: util.joinValues(expectedValues),
        received: ctx2.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx2, {
        received: ctx2.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
}
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
class ZodPromise extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx: ctx2 } = this._processInputParams(input);
    if (ctx2.parsedType !== ZodParsedType.promise && ctx2.common.async === false) {
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const promisified = ctx2.parsedType === ZodParsedType.promise ? ctx2.data : Promise.resolve(ctx2.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx2.path,
        errorMap: ctx2.common.contextualErrorMap
      });
    }));
  }
}
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
class ZodEffects extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx: ctx2 } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx2, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx2.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx2.data, checkCtx);
      if (ctx2.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx2.path,
            parent: ctx2
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx2.path,
          parent: ctx2
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx2.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx2.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx2.data,
          path: ctx2.path,
          parent: ctx2
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx2.data, path: ctx2.path, parent: ctx2 }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx2.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx2.data,
          path: ctx2.path,
          parent: ctx2
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx2.data, path: ctx2.path, parent: ctx2 }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
}
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
class ZodOptional extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
class ZodNullable extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
class ZodDefault extends ZodType {
  _parse(input) {
    const { ctx: ctx2 } = this._processInputParams(input);
    let data = ctx2.data;
    if (ctx2.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx2.path,
      parent: ctx2
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
}
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
class ZodCatch extends ZodType {
  _parse(input) {
    const { ctx: ctx2 } = this._processInputParams(input);
    const newCtx = {
      ...ctx2,
      common: {
        ...ctx2.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
}
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
class ZodNaN extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
}
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
class ZodBranded extends ZodType {
  _parse(input) {
    const { ctx: ctx2 } = this._processInputParams(input);
    const data = ctx2.data;
    return this._def.type._parse({
      data,
      path: ctx2.path,
      parent: ctx2
    });
  }
  unwrap() {
    return this._def.type;
  }
}
class ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx: ctx2 } = this._processInputParams(input);
    if (ctx2.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx2.data,
          path: ctx2.path,
          parent: ctx2
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx2.path,
            parent: ctx2
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx2.data,
        path: ctx2.path,
        parent: ctx2
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx2.path,
          parent: ctx2
        });
      }
    }
  }
  static create(a, b) {
    return new ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
}
class ZodReadonly extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
const stringType = ZodString.create;
const numberType = ZodNumber.create;
const booleanType = ZodBoolean.create;
const unknownType = ZodUnknown.create;
ZodNever.create;
const arrayType = ZodArray.create;
const objectType = ZodObject.create;
const unionType = ZodUnion.create;
const discriminatedUnionType = ZodDiscriminatedUnion.create;
ZodIntersection.create;
ZodTuple.create;
const literalType = ZodLiteral.create;
const enumType = ZodEnum.create;
ZodPromise.create;
ZodOptional.create;
ZodNullable.create;
const askUserSchema = {
  question: stringType().describe("The question to ask. Clear, specific, ending with a question mark."),
  header: stringType().max(12).optional().describe('Very short label (max 12 chars) shown as a chip, e.g. "Auth method".'),
  options: arrayType(
    objectType({
      label: stringType().describe("Concise option text (1-5 words)."),
      description: stringType().optional().describe("What this option means / implications of choosing it.")
    })
  ).min(2).max(4).optional().describe(
    '2-4 mutually exclusive choices. Omit for a pure free-text question. Do NOT add "Other" — the user can always type freely.'
  ),
  multiSelect: booleanType().optional().describe("Allow multiple selections. Default false.")
};
function createAskUserServer(onQuestion) {
  const pending = /* @__PURE__ */ new Map();
  let counter = 0;
  const server = new McpServer(
    { name: "catmax", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.tool(
    "ask_user",
    `Ask the user ONE clarifying question when their request is ambiguous or needs a preference/decision before you proceed. Do NOT guess — if you're unsure about a meaningful choice (library, approach, scope), ask first. Call with a single question and 2-4 mutually exclusive options. Never add an "Other" option: the user can always type a free-form answer instead of picking. Ask at most one question per call; if you need multiple pieces of info, ask the most important one first.`,
    askUserSchema,
    async (args) => {
      const requestId = `q${++counter}`;
      const question = { question: args.question };
      if (args.header) question.header = args.header;
      if (args.multiSelect) question.multiSelect = args.multiSelect;
      if (args.options) {
        question.options = args.options.map((o) => {
          const opt = { label: o.label };
          if (o.description) opt.description = o.description;
          return opt;
        });
      }
      onQuestion(requestId, question);
      const answer = await new Promise((resolve2) => {
        pending.set(requestId, { resolve: resolve2 });
      });
      return {
        content: [{ type: "text", text: formatAnswerForModel(question, answer) }]
      };
    }
  );
  return {
    server,
    respondQuestion(requestId, answer) {
      const entry = pending.get(requestId);
      if (!entry) return false;
      pending.delete(requestId);
      entry.resolve(answer);
      return true;
    },
    rejectAll() {
      for (const [, entry] of pending) entry.resolve({ selectedLabels: [], freeText: "" });
      pending.clear();
    }
  };
}
function formatAnswerForModel(question, answer) {
  const hasSelection = answer.selectedLabels.length > 0;
  const hasFreeText = answer.freeText && answer.freeText.trim().length > 0;
  if (!hasSelection && !hasFreeText) {
    return "用户跳过了这个问题（按了取消）。你可以基于你的最佳判断继续，或者换个角度再问。";
  }
  if (hasFreeText && !hasSelection) {
    return answer.freeText;
  }
  const prefix = question.header || "回答";
  const selection = answer.selectedLabels.join(", ");
  return hasFreeText ? `[${prefix}] ${selection}
${answer.freeText}` : `[${prefix}] ${selection}`;
}
class ClaudeBackgroundTaskState {
  tasks = /* @__PURE__ */ new Map();
  liveTaskIds = /* @__PURE__ */ new Set();
  seenNotificationUuids = /* @__PURE__ */ new Set();
  sawBackgroundTask = false;
  initialResultSeen = false;
  pendingNotificationFollowup = false;
  cancelling = false;
  usage = {};
  handle(message) {
    switch (message.subtype) {
      case "background_tasks_changed":
        return this.handleMembership(message);
      case "task_started":
        return [this.handleStarted(message)];
      case "task_progress":
        return [this.handleProgress(message)];
      case "task_notification":
        return this.handleNotification(message);
    }
  }
  handleUserMessage(message) {
    const toolUseResult = message.tool_use_result;
    if (toolUseResult === null || typeof toolUseResult !== "object") return [];
    const result = toolUseResult;
    const isAsyncLaunch = result.status === "async_launched" || result.status === "remote_launched" || result.isAsync === true;
    if (!isAsyncLaunch) return [];
    const taskId = typeof result.agentId === "string" ? result.agentId : typeof result.taskId === "string" ? result.taskId : void 0;
    if (!taskId) return [];
    const toolUseId = this.findToolUseId(message);
    const existing = this.tasks.get(taskId);
    const description = typeof result.description === "string" ? result.description : existing?.snapshot.description;
    const snapshot = {
      taskId,
      ...toolUseId ? { toolUseId } : existing?.snapshot.toolUseId ? { toolUseId: existing.snapshot.toolUseId } : {},
      status: "running",
      ...description ? { description } : {},
      stats: {
        ...existing?.snapshot.stats ?? {},
        agentId: taskId,
        status: "running"
      }
    };
    this.sawBackgroundTask = true;
    this.liveTaskIds.add(taskId);
    this.tasks.set(taskId, { snapshot, attempt: existing?.attempt ?? 1 });
    return [this.copy(snapshot)];
  }
  classifyResult(message) {
    this.accumulateUsage(message);
    if (message.is_error || this.cancelling) return "terminal";
    if (!this.sawBackgroundTask) return "terminal";
    if (!this.initialResultSeen) {
      this.initialResultSeen = true;
      return "intermediate";
    }
    const allTerminal = this.tasks.size > 0 && [...this.tasks.values()].every(({ snapshot }) => snapshot.status !== "running");
    const isNotificationFollowup = message.origin?.kind === "task-notification" || this.pendingNotificationFollowup;
    if (this.liveTaskIds.size === 0 && allTerminal && isNotificationFollowup) {
      this.pendingNotificationFollowup = false;
      return "terminal";
    }
    if (isNotificationFollowup) this.pendingNotificationFollowup = false;
    return "intermediate";
  }
  markCancelling() {
    this.cancelling = true;
    this.liveTaskIds.clear();
    const updates = [];
    for (const task of this.tasks.values()) {
      if (task.snapshot.status !== "running") continue;
      task.snapshot.status = "stopped";
      task.snapshot.stats.status = "stopped";
      task.snapshot.summary = "用户已停止任务";
      updates.push(this.copy(task.snapshot));
    }
    return updates;
  }
  isCancelling() {
    return this.cancelling;
  }
  activeTaskIds() {
    return [...this.liveTaskIds];
  }
  accumulatedUsage() {
    return { ...this.usage };
  }
  handleMembership(message) {
    const previousLiveTaskIds = this.liveTaskIds;
    const nextLiveTaskIds = new Set(message.tasks.map((task) => task.task_id));
    const updates = [];
    this.liveTaskIds = nextLiveTaskIds;
    if (message.tasks.length > 0) this.sawBackgroundTask = true;
    for (const taskId of previousLiveTaskIds) {
      if (nextLiveTaskIds.has(taskId)) continue;
      const existing = this.tasks.get(taskId);
      if (!existing || existing.snapshot.status !== "running") continue;
      existing.snapshot.status = "completed";
      existing.snapshot.summary = "后台任务已结束";
      existing.snapshot.stats.status = "completed";
      updates.push(this.copy(existing.snapshot));
      this.pendingNotificationFollowup = true;
    }
    for (const task of message.tasks) {
      const existing = this.tasks.get(task.task_id);
      if (existing) {
        existing.snapshot.status = "running";
        existing.snapshot.description = task.description;
        existing.snapshot.stats.status = "running";
        updates.push(this.copy(existing.snapshot));
        continue;
      }
      const snapshot = {
        taskId: task.task_id,
        status: "running",
        description: task.description,
        stats: { agentId: task.task_id, status: "running" }
      };
      this.tasks.set(task.task_id, { snapshot, attempt: 1 });
      updates.push(this.copy(snapshot));
    }
    return updates;
  }
  handleStarted(message) {
    this.sawBackgroundTask = true;
    this.liveTaskIds.add(message.task_id);
    const previous = this.tasks.get(message.task_id);
    const attempt = previous && previous.snapshot.status !== "running" ? previous.attempt + 1 : previous?.attempt ?? 1;
    const stats = {
      agentId: message.task_id,
      status: "running",
      ...message.subagent_type ? { agentType: message.subagent_type } : {}
    };
    const snapshot = {
      taskId: message.task_id,
      ...message.tool_use_id ? { toolUseId: message.tool_use_id } : {},
      status: "running",
      description: message.description,
      stats
    };
    this.tasks.set(message.task_id, { snapshot, attempt });
    return this.copy(snapshot);
  }
  handleProgress(message) {
    this.sawBackgroundTask = true;
    this.liveTaskIds.add(message.task_id);
    const existing = this.tasks.get(message.task_id);
    const stats = {
      ...existing?.snapshot.stats ?? {},
      agentId: message.task_id,
      status: "running",
      totalDurationMs: message.usage.duration_ms,
      totalTokens: message.usage.total_tokens,
      totalToolUseCount: message.usage.tool_uses,
      ...message.subagent_type ? { agentType: message.subagent_type } : {},
      ...message.summary ? { progressSummary: message.summary } : {},
      ...message.last_tool_name ? { lastToolName: message.last_tool_name } : {}
    };
    const snapshot = {
      taskId: message.task_id,
      ...message.tool_use_id ? { toolUseId: message.tool_use_id } : existing?.snapshot.toolUseId ? { toolUseId: existing.snapshot.toolUseId } : {},
      status: "running",
      description: message.description,
      ...message.summary ? { summary: message.summary } : {},
      stats
    };
    this.tasks.set(message.task_id, {
      snapshot,
      attempt: existing?.attempt ?? 1
    });
    return this.copy(snapshot);
  }
  handleNotification(message) {
    if (this.seenNotificationUuids.has(message.uuid)) return [];
    this.seenNotificationUuids.add(message.uuid);
    this.sawBackgroundTask = true;
    this.liveTaskIds.delete(message.task_id);
    this.pendingNotificationFollowup = true;
    const existing = this.tasks.get(message.task_id);
    const status = message.status;
    const stats = {
      ...existing?.snapshot.stats ?? {},
      agentId: message.task_id,
      status,
      ...message.usage ? {
        totalDurationMs: message.usage.duration_ms,
        totalTokens: message.usage.total_tokens,
        totalToolUseCount: message.usage.tool_uses
      } : {}
    };
    const snapshot = {
      taskId: message.task_id,
      ...message.tool_use_id ? { toolUseId: message.tool_use_id } : existing?.snapshot.toolUseId ? { toolUseId: existing.snapshot.toolUseId } : {},
      status,
      ...existing?.snapshot.description ? { description: existing.snapshot.description } : {},
      summary: message.summary,
      stats
    };
    this.tasks.set(message.task_id, {
      snapshot,
      attempt: existing?.attempt ?? 1
    });
    return [this.copy(snapshot)];
  }
  accumulateUsage(message) {
    this.usage.inputTokens = (this.usage.inputTokens ?? 0) + (message.usage.input_tokens ?? 0);
    this.usage.outputTokens = (this.usage.outputTokens ?? 0) + (message.usage.output_tokens ?? 0);
    this.usage.cacheReadTokens = (this.usage.cacheReadTokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0);
    this.usage.costUsd = (this.usage.costUsd ?? 0) + (message.total_cost_usd ?? 0);
  }
  findToolUseId(message) {
    const content = message.message.content;
    if (!Array.isArray(content)) return void 0;
    for (const block of content) {
      if (typeof block === "object" && block !== null && block.type === "tool_result" && typeof block.tool_use_id === "string") {
        return block.tool_use_id;
      }
    }
    return void 0;
  }
  copy(snapshot) {
    return { ...snapshot, stats: { ...snapshot.stats } };
  }
}
const IDE_SELECTION_RE = /<ide_selection>The user selected the (?:lines?|line) (\d+)(?:\s+to\s+(\d+))? from (.+?):\n([\s\S]*?)\nThis may or may not be related to the current task\.<\/ide_selection>/g;
function extractIdeSelection(text) {
  const out = [];
  IDE_SELECTION_RE.lastIndex = 0;
  let m;
  while ((m = IDE_SELECTION_RE.exec(text)) !== null) {
    const startLine = parseInt(m[1], 10);
    const endLine = m[2] ? parseInt(m[2], 10) : startLine;
    const filePath = m[3].trim();
    const code = m[4];
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      data: { filePath, startLine, endLine, code }
    });
  }
  return out;
}
const IDE_OPENED_FILE_RE = /<ide_opened_file>The user opened the file (.+?) in the IDE\. This may or may not be related to the current task\.<\/ide_opened_file>/g;
function extractIdeOpenedFile(text) {
  const out = [];
  IDE_OPENED_FILE_RE.lastIndex = 0;
  let m;
  while ((m = IDE_OPENED_FILE_RE.exec(text)) !== null) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      data: { filePath: m[1].trim() }
    });
  }
  return out;
}
const ENVIRONMENT_CONTEXT_RE = /<environment_context>([\s\S]*?)<\/environment_context>/g;
function extractEnvironmentContext(text) {
  const out = [];
  ENVIRONMENT_CONTEXT_RE.lastIndex = 0;
  let m;
  while ((m = ENVIRONMENT_CONTEXT_RE.exec(text)) !== null) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      data: { raw: m[1] }
    });
  }
  return out;
}
const sharedContextTagExtractors = [
  {
    tag: "ide_selection",
    extract: extractIdeSelection
  },
  {
    tag: "ide_opened_file",
    extract: extractIdeOpenedFile
  },
  {
    tag: "environment_context",
    extract: extractEnvironmentContext
  }
];
function extractContextTags(text, extractors) {
  const allMatches = [];
  for (const ext of extractors) {
    const removeFromText = ext.removeFromText !== false;
    const matches = ext.extract(text);
    for (const m of matches) {
      allMatches.push({ ...m, tag: ext.tag, removeFromText });
    }
  }
  if (allMatches.length === 0) {
    return { text, blocks: [] };
  }
  allMatches.sort((a, b) => a.start - b.start);
  const kept = [];
  let lastEnd = -1;
  for (const m of allMatches) {
    if (m.start >= lastEnd) {
      kept.push(m);
      lastEnd = m.end;
    }
  }
  let newText = "";
  let cursor = 0;
  const blocks = [];
  for (const m of kept) {
    newText += text.slice(cursor, m.start);
    blocks.push({ tag: m.tag, data: m.data });
    cursor = m.end;
  }
  newText += text.slice(cursor);
  newText = newText.replace(/\n{3,}/g, "\n\n");
  newText = newText.replace(/^\n+/, "").replace(/\n+$/, "");
  return { text: newText, blocks };
}
const INTERRUPT_MARKER_RE = /^\[Request interrupted by user( for tool use)?\]$/;
function matchInterruptMarker(text) {
  const m = text.trim().match(INTERRUPT_MARKER_RE);
  if (!m) return null;
  return { variant: m[1] ? "tool" : "user" };
}
function messageBlocks(message) {
  if (message.blocks) return message.blocks;
  const blocks = [];
  for (const context of message.contextBlocks ?? []) {
    blocks.push({
      id: `${message.id}-context-${blocks.length}`,
      type: "context",
      ...context
    });
  }
  for (const tool of message.toolBlocks ?? []) {
    blocks.push({ type: "tool_call", ...tool });
  }
  for (const text of message.textBlocks ?? []) {
    blocks.push({
      id: text.id,
      type: text.kind === "reasoning" ? "reasoning" : "text",
      text: text.text,
      ...text.startedAt !== void 0 ? { startedAt: text.startedAt } : {},
      ...text.endedAt !== void 0 ? { endedAt: text.endedAt } : {}
    });
  }
  return blocks;
}
function upgradeMessageBlocks(message) {
  if (message.blocks) return message;
  return { ...message, blocks: messageBlocks(message) };
}
function assessRisk(kind, detail) {
  if (kind === "shell_command") {
    if (/^(git status|git log|git diff|git branch|ls|ll|cat|pwd|echo|grep|find|rg|fd|head|tail|wc|which)\b/.test(
      detail
    )) {
      return "low";
    }
    if (/\b(rm|git push --force|git push -f|git reset --hard|npm publish|sudo|chmod|chown|dd|mkfs|curl|wget)\b/.test(
      detail
    )) {
      return "high";
    }
    return "medium";
  }
  if (kind === "file_edit") return "medium";
  if (kind === "mcp") return "medium";
  return "medium";
}
function toolUseToInfo(block) {
  const input = block.input;
  switch (block.name) {
    case "Bash":
      return {
        kind: "shell_command",
        title: typeof input?.command === "string" ? input.command.slice(0, 80) : "(empty command)",
        ...typeof input?.command === "string" ? { detail: input.command } : {}
      };
    case "Edit":
      return {
        kind: "file_edit",
        title: typeof input?.file_path === "string" ? input.file_path : "(unknown file)",
        edit: {
          type: "string_replace",
          filePath: typeof input?.file_path === "string" ? input.file_path : "",
          oldString: typeof input?.old_string === "string" ? input.old_string : "",
          newString: typeof input?.new_string === "string" ? input.new_string : ""
        }
      };
    case "MultiEdit": {
      const filePath = typeof input?.file_path === "string" ? input.file_path : "";
      const editsRaw = Array.isArray(input?.edits) ? input.edits : [];
      const edits = editsRaw.map((e) => {
        if (typeof e !== "object" || e === null) return null;
        const eo = e;
        return {
          oldString: typeof eo.old_string === "string" ? eo.old_string : "",
          newString: typeof eo.new_string === "string" ? eo.new_string : ""
        };
      }).filter((e) => e !== null);
      return {
        kind: "file_edit",
        title: filePath,
        edit: {
          type: "string_replace",
          filePath,
          oldString: edits[0]?.oldString ?? "",
          newString: edits[0]?.newString ?? "",
          edits
        }
      };
    }
    case "Write":
      return {
        kind: "file_edit",
        title: typeof input?.file_path === "string" ? input.file_path : "(unknown file)",
        edit: {
          type: "full_content",
          filePath: typeof input?.file_path === "string" ? input.file_path : "",
          content: typeof input?.content === "string" ? input.content : ""
        }
      };
    case "NotebookEdit":
      return {
        kind: "file_edit",
        title: typeof input?.notebook_path === "string" ? input.notebook_path : "(unknown notebook)",
        edit: {
          type: "full_content",
          filePath: typeof input?.notebook_path === "string" ? input.notebook_path : "",
          content: typeof input?.new_source === "string" ? input.new_source : ""
        }
      };
    case "NotebookRead":
    case "Read":
    case "Glob":
    case "Grep": {
      const path = typeof input?.file_path === "string" ? input.file_path : typeof input?.pattern === "string" ? input.pattern : typeof input?.path === "string" ? input.path : "(unknown)";
      const prefix = block.name === "Glob" ? "Glob" : block.name === "Grep" ? "Grep" : "Read";
      return {
        kind: "file_read",
        title: `${prefix}: ${path}`
      };
    }
    case "WebSearch":
      return {
        kind: "web",
        title: typeof input?.query === "string" ? input.query.slice(0, 80) : "web search",
        web: {
          type: "search",
          query: typeof input?.query === "string" ? input.query : "",
          ...Array.isArray(input?.allowedDomains) ? { allowedDomains: input.allowedDomains } : {},
          ...Array.isArray(input?.blockedDomains) ? { blockedDomains: input.blockedDomains } : {}
        }
      };
    case "WebFetch":
      return {
        kind: "web",
        title: typeof input?.url === "string" ? input.url.slice(0, 80) : "web fetch",
        web: {
          type: "fetch",
          query: typeof input?.url === "string" ? input.url : "",
          ...typeof input?.prompt === "string" ? { prompt: input.prompt } : {}
        }
      };
    case "Task":
      return {
        kind: "task",
        title: typeof input?.description === "string" ? input.description.slice(0, 80) : "sub-agent task",
        task: {
          description: typeof input?.description === "string" ? input.description : "",
          prompt: typeof input?.prompt === "string" ? input.prompt : ""
        }
      };
    case "EnterPlanMode":
      return {
        kind: "control",
        title: "Enter Plan Mode",
        control: { type: "enter_plan_mode" }
      };
    case "ExitPlanMode":
      return {
        kind: "control",
        title: "Exit Plan Mode",
        control: {
          type: "exit_plan_mode",
          ...typeof input?.plan === "string" ? { plan: input.plan } : {}
        }
      };
    case "TodoWrite": {
      const todosRaw = Array.isArray(input?.todos) ? input.todos : [];
      const todos = todosRaw.map((t) => {
        if (typeof t !== "object" || t === null) return null;
        const to = t;
        const rawStatus = typeof to.status === "string" ? to.status : "pending";
        const status = rawStatus === "in_progress" || rawStatus === "completed" ? rawStatus : "pending";
        return {
          content: typeof to.content === "string" ? to.content : "",
          status,
          ...typeof to.activeForm === "string" ? { activeForm: to.activeForm } : {}
        };
      }).filter(
        (t) => t !== null
      );
      return {
        kind: "control",
        title: "Update Todos",
        control: { type: "todo_write", todos }
      };
    }
    default:
      if (block.name.startsWith("mcp__")) {
        return {
          kind: "mcp",
          title: block.name
        };
      }
      return {
        kind: "other",
        title: block.name
      };
  }
}
function toolResultToOutput(block) {
  const isError = block.is_error === true;
  let output;
  if (typeof block.content === "string") {
    output = block.content;
  } else if (Array.isArray(block.content)) {
    output = block.content.map(
      (c) => typeof c === "object" && c !== null && "text" in c ? String(c.text) : String(c)
    ).join("\n");
  }
  return {
    ok: !isError,
    summary: isError ? "failed" : "completed",
    ...output !== void 0 ? { output } : {}
  };
}
function toolUseResultToStats(tur) {
  if (tur === null || typeof tur !== "object") return void 0;
  const r = tur;
  const stats = r.toolStats;
  return {
    ...typeof r.agentId === "string" ? { agentId: r.agentId } : {},
    ...typeof r.totalDurationMs === "number" ? { totalDurationMs: r.totalDurationMs } : {},
    ...typeof r.totalTokens === "number" ? { totalTokens: r.totalTokens } : {},
    ...typeof r.totalToolUseCount === "number" ? { totalToolUseCount: r.totalToolUseCount } : {},
    ...typeof r.agentType === "string" ? { agentType: r.agentType } : {},
    ...stats !== null && typeof stats === "object" ? {
      toolStats: {
        ...typeof stats.readCount === "number" ? { readCount: stats.readCount } : {},
        ...typeof stats.searchCount === "number" ? { searchCount: stats.searchCount } : {},
        ...typeof stats.bashCount === "number" ? { bashCount: stats.bashCount } : {},
        ...typeof stats.editFileCount === "number" ? { editFileCount: stats.editFileCount } : {},
        ...typeof stats.linesAdded === "number" ? { linesAdded: stats.linesAdded } : {},
        ...typeof stats.linesRemoved === "number" ? { linesRemoved: stats.linesRemoved } : {},
        ...typeof stats.otherToolCount === "number" ? { otherToolCount: stats.otherToolCount } : {}
      }
    } : {}
  };
}
function claudePermissionToApprovalRequest(toolName, input, meta) {
  if (toolName === "ExitPlanMode") {
    const plan = typeof input.plan === "string" ? input.plan : "";
    return {
      kind: "mcp",
      title: "计划已准备好",
      detail: "",
      riskLevel: "low",
      plan,
      ...pickMeta(meta)
    };
  }
  if (toolName === "Bash") {
    const cmd = typeof input.command === "string" ? input.command : JSON.stringify(input);
    const description = typeof input.description === "string" ? input.description : void 0;
    const detail = description ? `$ ${cmd}

${description}` : `$ ${cmd}`;
    return {
      kind: "shell_command",
      // SDK 的 title（"Claude wants to run..."）优先；没有时回退到命令本身
      title: meta?.title || cmd.slice(0, 100),
      detail,
      riskLevel: assessRisk("shell_command", cmd),
      ...pickMeta(meta)
    };
  }
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
    const filePath = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : "(unknown)";
    return {
      kind: "file_edit",
      title: meta?.title || filePath,
      detail: JSON.stringify(input, null, 2),
      riskLevel: assessRisk("file_edit", filePath),
      ...pickMeta(meta)
    };
  }
  return {
    kind: "mcp",
    title: meta?.title || toolName,
    detail: JSON.stringify(input, null, 2),
    riskLevel: "medium",
    ...pickMeta(meta)
  };
}
function pickMeta(meta) {
  const out = {};
  if (meta?.displayName) out.displayName = meta.displayName;
  if (meta?.description) out.description = meta.description;
  if (meta?.decisionReason) out.decisionReason = meta.decisionReason;
  return out;
}
function extractCommandName(text) {
  if (!text.includes("<command-message>")) return null;
  const m = text.match(/<command-name>([^<]+)<\/command-name>/);
  const name = m?.[1];
  return name ? name.trim() : null;
}
function extractCompactSummary(text) {
  if (text.startsWith("This session is being continued from a previous conversation")) {
    return text;
  }
  return null;
}
function isSystemSentinel(text) {
  if (text.includes("<local-command-caveat>")) return true;
  if (text.includes("<local-command-stdout>")) return true;
  return false;
}
function appendAssistantBlocks(target, assistantMsg, pendingToolUseIds) {
  for (const block of assistantMsg.message.content) {
    if (block.type === "text") {
      const text = block.text;
      if (text) {
        target.textBlocks.push({ id: randomUUID(), text, kind: "text" });
      }
    } else if (block.type === "thinking") {
      const text = block.thinking;
      if (text) {
        target.textBlocks.push({ id: randomUUID(), text, kind: "reasoning" });
      }
    } else if (block.type === "tool_use") {
      const tu = block;
      const info = toolUseToInfo(tu);
      target.toolBlocks.push({
        id: tu.id,
        info,
        status: "running"
        // 等 tool_result 改成 completed/failed
        // 历史回放没有精确 startedAt，但 UI 可以从 taskStats.totalDurationMs 反推（非必须）
      });
      pendingToolUseIds.set(tu.id, { info, messageId: target.id });
    }
  }
}
function claudeReplayToMessages(messages) {
  const result = [];
  let currentAssistant = null;
  const pendingToolUseIds = /* @__PURE__ */ new Map();
  let lastWasCommandInvocation = false;
  let pendingCompactSummary = null;
  function flushAssistant() {
    if (currentAssistant) {
      const hasText = (currentAssistant.textBlocks?.length ?? 0) > 0;
      const hasTool = (currentAssistant.toolBlocks?.length ?? 0) > 0;
      const hasOtherBlocks = (currentAssistant.blocks?.length ?? 0) > 0;
      if (hasText || hasTool || hasOtherBlocks) {
        result.push(currentAssistant);
      }
      currentAssistant = null;
    }
  }
  for (const msg of messages) {
    if (msg.type === "assistant") {
      const assistantMsg = msg;
      lastWasCommandInvocation = false;
      if (currentAssistant && currentAssistant.id === assistantMsg.message.id) {
        appendAssistantBlocks(currentAssistant, assistantMsg, pendingToolUseIds);
        continue;
      }
      flushAssistant();
      const assistant = {
        id: assistantMsg.message.id,
        role: "assistant",
        turnId: "history",
        textBlocks: [],
        toolBlocks: [],
        createdAt: 0
      };
      appendAssistantBlocks(assistant, assistantMsg, pendingToolUseIds);
      currentAssistant = assistant;
    } else if (msg.type === "user") {
      const userMsg = msg;
      const content = userMsg.message.content;
      const collectedText = [];
      for (const block of content) {
        if (block.type === "tool_result") {
          const tr = block;
          lastWasCommandInvocation = false;
          const output = toolResultToOutput(tr);
          const target = result.find((m) => pendingToolUseIds.get(tr.tool_use_id)?.messageId === m.id) ?? (currentAssistant !== null && pendingToolUseIds.get(tr.tool_use_id)?.messageId === currentAssistant.id ? currentAssistant : null);
          if (target?.toolBlocks) {
            const tb = target.toolBlocks.find((b) => b.id === tr.tool_use_id);
            if (tb) {
              tb.status = output.ok ? "completed" : "failed";
              tb.output = output;
              const stats = toolUseResultToStats(userMsg.tool_use_result);
              if (stats !== void 0) tb.taskStats = stats;
            }
          }
          pendingToolUseIds.delete(tr.tool_use_id);
        } else if (block.type === "text") {
          collectedText.push(block.text);
        }
      }
      if (collectedText.length > 0) {
        flushAssistant();
        const rawText = collectedText.join("\n\n");
        const compactSummary = extractCompactSummary(rawText);
        if (compactSummary !== null) {
          pendingCompactSummary = compactSummary;
          continue;
        }
        if (isSystemSentinel(rawText)) {
          continue;
        }
        if (matchInterruptMarker(rawText)) {
          lastWasCommandInvocation = false;
          result.push({
            id: randomUUID(),
            role: "user",
            turnId: "history",
            textBlocks: [{ id: randomUUID(), text: rawText.trim(), kind: "text" }],
            createdAt: 0
          });
          continue;
        }
        const cmdName = extractCommandName(rawText);
        if (cmdName) {
          const textBlocks = [
            { id: randomUUID(), text: cmdName, kind: "text" }
          ];
          if (cmdName === "/compact" && pendingCompactSummary) {
            textBlocks.push({
              id: randomUUID(),
              text: pendingCompactSummary,
              kind: "text"
            });
          }
          pendingCompactSummary = null;
          result.push({
            id: randomUUID(),
            role: "user",
            turnId: "history",
            textBlocks,
            createdAt: 0
          });
          lastWasCommandInvocation = true;
        } else if (lastWasCommandInvocation) {
          lastWasCommandInvocation = false;
        } else {
          const { text, blocks } = extractContextTags(rawText, sharedContextTagExtractors);
          if (text.trim() || blocks.length > 0) {
            result.push({
              id: randomUUID(),
              role: "user",
              turnId: "history",
              textBlocks: text.trim() ? [{ id: randomUUID(), text, kind: "text" }] : [],
              ...blocks.length > 0 ? { contextBlocks: blocks } : {},
              createdAt: 0
            });
          }
        }
      }
    }
  }
  flushAssistant();
  for (const msg of result) {
    if (msg.toolBlocks) {
      for (const tb of msg.toolBlocks) {
        if (tb.status === "running") {
          tb.status = "completed";
          tb.output = { ok: true, summary: "(no result recorded)" };
        }
      }
    }
  }
  return result.map(upgradeMessageBlocks);
}
const log$k = logger.domain("claude-jsonl");
function encodeCwdToProjectDir(cwd) {
  return cwd.replace(/\//g, "-");
}
function decodeProjectDirToCwd(dir) {
  return dir.replace(/-/g, "/");
}
function resolveSessionJsonlPath(sessionId, cwd) {
  const baseCwd = cwd ?? process.cwd();
  const projectDir = encodeCwdToProjectDir(baseCwd);
  return join(homedir(), ".claude", "projects", projectDir, `${sessionId}.jsonl`);
}
async function readTitleAndModel(filePath) {
  let title = null;
  let model = null;
  try {
    const stream = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity
    });
    for await (const rawLine of stream) {
      const line = rawLine.trim();
      if (!line) continue;
      if (!line.includes('"type"')) continue;
      try {
        const obj = JSON.parse(line);
        if (!title && obj.type === "ai-title" && obj.aiTitle) {
          title = obj.aiTitle;
        }
        if (!model && obj.type === "assistant" && obj.message?.model) {
          model = obj.message.model;
        }
        if (title && model) break;
      } catch {
      }
    }
  } catch {
  }
  return { title, model };
}
async function listClaudeSessionsFromDisk(cwd) {
  const projectsRoot = join(homedir(), ".claude", "projects");
  let targets;
  if (cwd) {
    const dirName = encodeCwdToProjectDir(cwd);
    targets = [{ dirName, decodedCwd: cwd }];
  } else {
    try {
      const entries = readdirSync(projectsRoot, { withFileTypes: true });
      targets = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => ({ dirName: e.name, decodedCwd: decodeProjectDirToCwd(e.name) }));
    } catch {
      log$k.info("projects root not found, returning empty:", projectsRoot);
      return [];
    }
  }
  const results = [];
  for (const { dirName, decodedCwd } of targets) {
    const dirPath = join(projectsRoot, dirName);
    let files;
    try {
      files = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const fileName2 of files) {
      if (!fileName2.endsWith(".jsonl") || fileName2.startsWith(".")) continue;
      const filePath = join(dirPath, fileName2);
      try {
        const stat2 = statSync(filePath);
        if (!stat2.isFile()) continue;
        const sessionId = fileName2.slice(0, -".jsonl".length);
        const { title, model } = await readTitleAndModel(filePath);
        results.push({
          backendThreadId: sessionId,
          cwd: decodedCwd,
          title,
          model,
          lastActiveAt: stat2.mtimeMs,
          sizeBytes: stat2.size
        });
      } catch {
      }
    }
  }
  log$k.info(
    "scan from disk",
    cwd ? `(cwd=${cwd})` : "(all projects)",
    "→",
    results.length,
    "sessions"
  );
  return results;
}
function normalizeUserContent(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
}
async function readClaudeSessionJsonl(sessionId, cwd) {
  const filePath = resolveSessionJsonlPath(sessionId, cwd);
  if (!existsSync(filePath)) {
    log$k.warn("jsonl not found:", filePath);
    return null;
  }
  const messages = [];
  let aiTitle = null;
  const stream = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity
  });
  for await (const rawLine of stream) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "ai-title" && obj.aiTitle) {
      aiTitle = obj.aiTitle;
      continue;
    }
    if (obj.type === "assistant" && obj.message) {
      messages.push(obj);
      continue;
    }
    if (obj.type === "user" && obj.message) {
      obj.message.content = normalizeUserContent(obj.message.content);
      messages.push(obj);
      continue;
    }
  }
  log$k.info("jsonl parsed", filePath, messages.length, "msgs, title=", aiTitle);
  return { messages, aiTitle };
}
async function readHistoryFromJsonl(sessionId, cwd) {
  const parsed = await readClaudeSessionJsonl(sessionId, cwd);
  if (!parsed) return null;
  const normalized = claudeReplayToMessages(parsed.messages);
  return { messages: normalized, aiTitle: parsed.aiTitle };
}
function resolveSubagentJsonlPath(agentId, cwd) {
  const projectDir = encodeCwdToProjectDir(cwd);
  return join(homedir(), ".claude", "projects", projectDir, "subagents", `agent-${agentId}.jsonl`);
}
async function readSubagentHistory$1(agentId, cwd) {
  const filePath = resolveSubagentJsonlPath(agentId, cwd);
  if (!existsSync(filePath)) {
    log$k.warn("subagent jsonl not found:", filePath);
    return [];
  }
  const messages = [];
  const stream = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity
  });
  for await (const rawLine of stream) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "assistant" && obj.message) {
      messages.push(obj);
      continue;
    }
    if (obj.type === "user" && obj.message) {
      obj.message.content = normalizeUserContent(obj.message.content);
      messages.push(obj);
      continue;
    }
  }
  log$k.info("subagent jsonl parsed", filePath, messages.length, "msgs");
  return claudeReplayToMessages(messages);
}
function sdkToToolUse(block) {
  return { type: "tool_use", id: block.id, name: block.name, input: block.input };
}
function sdkToToolResult(block) {
  return {
    type: "tool_result",
    tool_use_id: block.tool_use_id,
    content: block.content,
    is_error: block.is_error
  };
}
function* sdkAssistantToEvents(msg, turnId) {
  for (const block of msg.message.content) {
    const itemId = sdkBlockId(block);
    switch (block.type) {
      case "text": {
        const text = block.text;
        yield { type: "text_delta", turnId, itemId, text };
        break;
      }
      case "thinking": {
        const text = block.thinking;
        yield { type: "reasoning_delta", turnId, itemId, text };
        break;
      }
      case "tool_use": {
        const toolUse = block;
        const tool = toolUseToInfo(sdkToToolUse(toolUse));
        yield { type: "tool_call_started", turnId, itemId, tool };
        break;
      }
    }
  }
}
function* sdkUserToolResultToEvents(msg, turnId) {
  const content = msg.message.content;
  if (!Array.isArray(content)) return;
  if (isAsyncToolLaunch(msg.tool_use_result)) return;
  const stats = toolUseResultToStats(msg.tool_use_result);
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    if (block.type === "tool_result") {
      const result = block;
      const itemId = result.tool_use_id;
      yield {
        type: "tool_call_completed",
        turnId,
        itemId,
        output: toolResultToOutput(sdkToToolResult(result)),
        ...stats !== void 0 ? { taskStats: stats } : {}
      };
    }
  }
}
function isAsyncToolLaunch(toolUseResult) {
  if (toolUseResult === null || typeof toolUseResult !== "object") return false;
  const result = toolUseResult;
  return result.status === "async_launched" || result.status === "remote_launched" || result.isAsync === true;
}
class SdkPartialAggregator {
  constructor(turnId) {
    this.turnId = turnId;
  }
  blocks = /* @__PURE__ */ new Map();
  firedToolStarts = /* @__PURE__ */ new Set();
  /** 单调递增序列：给没有 API id 的 block（text/thinking）生成全局唯一 itemId */
  blockSeq = 0;
  /** 喂一条 partial 消息，返回要 emit 的 TurnEvent[] */
  push(msg) {
    return this.handleStreamEvent(msg.event);
  }
  /** turn 结束时兜底：把还没发 tool_call_started 的 tool_use 补上 */
  flushPendingToolUse() {
    const events = [];
    for (const [, block] of this.blocks) {
      if (block.type === "tool_use" && block.itemId && !this.firedToolStarts.has(block.itemId)) {
        const ev = this.buildToolCallStarted(block);
        if (ev) events.push(ev);
      }
    }
    return events;
  }
  // SDK 的 event 类型是 BetaRawMessageStreamEvent（来自 @anthropic-ai/sdk），
  // 这里用结构化的 case 判断，不直接引用该类型。
  handleStreamEvent(event) {
    const events = [];
    const evt = event;
    switch (evt.type) {
      case "message_start": {
        this.blocks.clear();
        break;
      }
      case "content_block_start": {
        const idx = evt.index;
        const block = evt.content_block;
        if (idx === void 0 || !block) break;
        const entry = { type: block.type };
        if (block.type === "tool_use") {
          if (block.id) entry.itemId = block.id;
          entry.toolName = block.name ?? "";
          entry.toolInputBuffer = "";
        } else {
          entry.itemId = `${block.type}-${this.blockSeq++}`;
        }
        this.blocks.set(idx, entry);
        break;
      }
      case "content_block_delta": {
        const idx = evt.index;
        const entry = idx !== void 0 ? this.blocks.get(idx) : void 0;
        if (!entry || !evt.delta) break;
        const delta = evt.delta;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          if (entry.itemId) {
            events.push({
              type: "text_delta",
              turnId: this.turnId,
              itemId: entry.itemId,
              text: delta.text
            });
          }
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          if (entry.itemId) {
            events.push({
              type: "reasoning_delta",
              turnId: this.turnId,
              itemId: entry.itemId,
              text: delta.thinking
            });
          }
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          if (entry.toolInputBuffer !== void 0) {
            entry.toolInputBuffer += delta.partial_json;
          }
        }
        break;
      }
      case "content_block_stop": {
        const idx = evt.index;
        const entry = idx !== void 0 ? this.blocks.get(idx) : void 0;
        if (!entry) break;
        if (entry.type === "tool_use" && entry.itemId) {
          const ev = this.buildToolCallStarted(entry);
          if (ev) events.push(ev);
        }
        break;
      }
    }
    return events;
  }
  buildToolCallStarted(entry) {
    if (!entry.itemId) return null;
    if (this.firedToolStarts.has(entry.itemId)) return null;
    this.firedToolStarts.add(entry.itemId);
    let input = {};
    if (entry.toolInputBuffer !== void 0 && entry.toolInputBuffer.length > 0) {
      try {
        input = JSON.parse(entry.toolInputBuffer);
      } catch {
        input = { _raw: entry.toolInputBuffer };
      }
    }
    const tool = toolUseToInfo({
      id: entry.itemId,
      name: entry.toolName ?? "",
      input
    });
    return { type: "tool_call_started", turnId: this.turnId, itemId: entry.itemId, tool };
  }
}
function sdkResultToEvent(msg, turnId, usageOverride, statusOverride) {
  const isErr = msg.is_error;
  const status = statusOverride ?? (isErr ? "error" : "completed");
  const usage = usageOverride ?? {
    ...msg.usage.input_tokens !== void 0 ? { inputTokens: msg.usage.input_tokens } : {},
    ...msg.usage.output_tokens !== void 0 ? { outputTokens: msg.usage.output_tokens } : {},
    ...msg.usage.cache_read_input_tokens !== void 0 ? { cacheReadTokens: msg.usage.cache_read_input_tokens } : {},
    ...msg.total_cost_usd !== void 0 ? { costUsd: msg.total_cost_usd } : {}
  };
  return {
    type: "turn_completed",
    turnId,
    status,
    usage
  };
}
function sdkSystemSessionId(msg) {
  return msg.session_id;
}
function sdkBlockId(block) {
  if (block.type === "tool_use") {
    return block.id;
  }
  return randomUUID();
}
function isSdkAssistantMessage(msg) {
  return msg.type === "assistant";
}
function isSdkPartialMessage(msg) {
  return msg.type === "stream_event";
}
function isSdkUserMessage(msg) {
  return msg.type === "user";
}
function isSdkResultMessage(msg) {
  return msg.type === "result";
}
function isSdkInitMessage(msg) {
  return msg.type === "system" && msg.subtype === "init";
}
const log$j = logger.domain("claude-adapter");
const WARMUP_CACHE_TTL_MS = 4 * 60 * 1e3;
const WARMUP_TIMEOUT_MS = 3e4;
const WARMUP_PROMPT = 'Warmup. Reply with exactly "ready" and do not use any tools.';
const ASK_USER_GUIDE = `## Asking the user questions with ask_user

You have an "ask_user" tool (mcp__catmax__ask_user). When the user's request is ambiguous or a meaningful choice is involved (which library/approach/scope to use, a preference, a trade-off), do NOT guess or pick a default — call ask_user to ask ONE clarifying question first. Provide 2-4 concise, mutually exclusive options. The user can always type a free-form answer instead of choosing, so never add an "Other" option. Ask only the single most important question; if you need multiple answers, ask sequentially. After receiving the answer, proceed accordingly.`;
class ClaudeAdapter {
  id = "claude";
  capabilities = CLAUDE_CAPABILITIES;
  opts;
  /** turnId → TurnContext（支持多 turn 并发） */
  turnContexts = /* @__PURE__ */ new Map();
  /** catmax 内部 session id → claude 真实 session id（首次 turn 后由 system.init 回填） */
  sessionIdMap = /* @__PURE__ */ new Map();
  /** 已拿到 claude 真实 session_id 的 session（决定能否 resume） */
  resumableSessions = /* @__PURE__ */ new Set();
  /** 额外 env（代理设置等），注入到 SDK query 的 options.env */
  extraEnv = {};
  /**
   * 可用模型列表缓存（首次 query 后从 initializationResult 拿到）。
   * undefined = 还没拿到过，listModels 返回静态 fallback。
   */
  modelsCache;
  /**
   * Prompt-cache 预热按 cwd/model/effort 去重。这里缓存的是临时 Warmup turn，
   * 与任何 Catmax 用户会话无关；完成后对应的 Claude JSONL 会被删除。
   */
  warmups = /* @__PURE__ */ new Map();
  constructor(opts = {}) {
    this.opts = opts;
  }
  // ---- 向后兼容：manager 通过 setBinaryPath/setExtraEnv 注入设置 ----
  // SDK 自带 binary，setBinaryPath 不再生效，但保留空实现避免 manager 报错。
  setBinaryPath(_path) {
    log$j.info("setBinaryPath ignored — Agent SDK bundles its own binary");
  }
  setExtraEnv(env) {
    this.extraEnv = env;
  }
  async initialize() {
    log$j.info("initialized (lazy, per-turn via SDK query)");
  }
  async healthCheck() {
    return { ok: true };
  }
  async dispose() {
    const turnIds = [...this.turnContexts.keys()];
    for (const id of turnIds) {
      const ctx2 = this.turnContexts.get(id);
      if (ctx2) {
        ctx2.interrupted = true;
        ctx2.abortController.abort();
      }
    }
    if (turnIds.length > 0) {
      log$j.info("dispose: aborted", turnIds.length, "running turn(s)");
    }
    this.turnContexts.clear();
  }
  getCapabilities() {
    return this.capabilities;
  }
  async listModels() {
    if (this.modelsCache && this.modelsCache.length > 0) {
      return this.modelsCache.map((m) => ({
        id: m.value,
        displayName: m.displayName,
        ...m.description ? { description: m.description } : {},
        ...m.supportedEffortLevels ? { supportedEfforts: this.mapEffortLevels(m.supportedEffortLevels) } : {}
      }));
    }
    return [
      { id: "sonnet", displayName: "Sonnet (latest)", isDefault: true },
      { id: "opus", displayName: "Opus (latest)" },
      { id: "haiku", displayName: "Haiku (latest)" }
    ];
  }
  invalidateModelsCache() {
    this.modelsCache = void 0;
  }
  /** SDK 的 effort 等级 → catmax 的 EffortLevel（补 'none'） */
  mapEffortLevels(levels) {
    return ["none", ...levels];
  }
  async startSession(args) {
    const sessionId = randomUUID();
    this.sessionIdMap.set(sessionId, sessionId);
    return { sessionId, backendThreadId: sessionId };
  }
  /**
   * Claude Code 风格的 cache warmup。
   *
   * Agent SDK 没有单独的 initialize-only API，因此用一次最小真实 query 提前写入
   * system prompt / tool schema 的 prompt cache。关键区别是使用独立 sessionId，
   * 并在完成后通过 SDK deleteSession 删除 transcript，绝不 resume 到用户会话。
   */
  async warmup(args) {
    const key = `${args.cwd}\0${args.model ?? ""}\0${args.effort ?? ""}`;
    const existing = this.warmups.get(key);
    if (existing) {
      if (existing.warmedAt === null) {
        log$j.info("warmup joined in-flight request", {
          cwd: args.cwd,
          model: args.model ?? "default",
          effort: args.effort ?? "default"
        });
        return existing.promise;
      }
      const ageMs = Date.now() - existing.warmedAt;
      if (ageMs < WARMUP_CACHE_TTL_MS) {
        log$j.info("warmup skipped: cache still fresh", {
          ageMs,
          cwd: args.cwd,
          model: args.model ?? "default",
          effort: args.effort ?? "default"
        });
        return existing.promise;
      }
      log$j.info("warmup cache expired; starting a new request", { ageMs, cwd: args.cwd });
      this.warmups.delete(key);
    }
    const state = {
      promise: Promise.resolve(),
      warmedAt: null
    };
    state.promise = this.runWarmup(args).then(() => {
      state.warmedAt = Date.now();
    }).catch((error) => {
      this.warmups.delete(key);
      throw error;
    });
    this.warmups.set(key, state);
    return state.promise;
  }
  async runWarmup(args) {
    const sessionId = randomUUID();
    const startedAt = Date.now();
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), WARMUP_TIMEOUT_MS);
    const askUser = createAskUserServer((_requestId, _question) => {
    });
    log$j.info("warmup started", {
      sessionId,
      cwd: args.cwd,
      model: args.model ?? "default",
      effort: args.effort ?? "default",
      timeoutMs: WARMUP_TIMEOUT_MS
    });
    const options = {
      abortController,
      allowDangerouslySkipPermissions: true,
      canUseTool: async () => ({
        behavior: "deny",
        message: "Warmup does not execute tools",
        interrupt: true
      }),
      cwd: args.cwd,
      env: { ...process.env, ...this.extraEnv },
      includePartialMessages: false,
      mcpServers: {
        catmax: { type: "sdk", name: "catmax", instance: askUser.server }
      },
      permissionMode: "default",
      sessionId,
      systemPrompt: { type: "preset", preset: "claude_code", append: ASK_USER_GUIDE }
    };
    if (args.model) options.model = args.model;
    if (args.effort) options.effort = args.effort === "none" ? "low" : args.effort;
    const binaryPath = this.resolveSdkBinaryPath();
    if (binaryPath !== void 0) options.pathToClaudeCodeExecutable = binaryPath;
    try {
      const sdkQuery = query({ prompt: WARMUP_PROMPT, options });
      for await (const message of sdkQuery) {
        if (isSdkResultMessage(message)) {
          const result = message;
          log$j.info("warmup result received", {
            sessionId,
            subtype: result.subtype ?? "unknown",
            isError: result.is_error ?? false
          });
        }
        if (isSdkInitMessage(message) && !this.modelsCache) {
          try {
            const init = await sdkQuery.initializationResult();
            if (init.models.length > 0) this.modelsCache = init.models;
          } catch (error) {
            log$j.debug("warmup initializationResult failed:", error);
          }
        }
      }
      log$j.info("warmup completed", {
        sessionId,
        durationMs: Date.now() - startedAt,
        cwd: args.cwd,
        model: args.model ?? "default"
      });
    } finally {
      clearTimeout(timeout);
      askUser.rejectAll();
      await askUser.server.close().catch((error) => log$j.debug("warmup ask_user server close failed:", error));
      try {
        await deleteSession(sessionId, { dir: args.cwd });
        log$j.info("warmup transcript deleted", { sessionId, cwd: args.cwd });
      } catch (error) {
        log$j.warn("warmup transcript cleanup failed:", { sessionId, cwd: args.cwd, error });
      }
    }
  }
  async listSessions(cwd) {
    return listClaudeSessionsFromDisk(cwd);
  }
  async deleteSession(backendThreadId, cwd) {
    const spawnCwd = cwd ?? this.opts.cwd;
    const jsonlPath = resolveSessionJsonlPath(backendThreadId, spawnCwd);
    try {
      await unlink(jsonlPath);
    } catch (e) {
      if (e.code === "ENOENT") return;
      log$j.warn("deleteSession: unlink failed", jsonlPath, e);
    }
  }
  async resumeSession(backendThreadId) {
    return { messages: [] };
  }
  async getHistory(backendThreadId, cwd) {
    const spawnCwd = cwd ?? this.opts.cwd;
    const result = await readHistoryFromJsonl(backendThreadId, spawnCwd);
    if (result === null) {
      throw new BackendError(
        "protocol",
        `claude getHistory(${backendThreadId}, cwd=${spawnCwd ?? "<include>"}): session jsonl not found`
      );
    }
    log$j.info(
      "history loaded from jsonl",
      backendThreadId,
      result.messages.length,
      "messages, title=",
      result.aiTitle
    );
    return { messages: result.messages, aiTitle: result.aiTitle };
  }
  // ============ 核心：startTurn ============
  async *startTurn(args) {
    const internalTurnId = randomUUID();
    yield { type: "turn_started", turnId: internalTurnId, sessionId: args.sessionId };
    const claudeSessionId = this.sessionIdMap.get(args.sessionId) ?? args.sessionId;
    let canResume = this.resumableSessions.has(args.sessionId);
    if (!canResume && args.cwd) {
      const jsonlPath = resolveSessionJsonlPath(args.sessionId, args.cwd);
      if (existsSync(jsonlPath)) {
        this.sessionIdMap.set(args.sessionId, args.sessionId);
        this.resumableSessions.add(args.sessionId);
        canResume = true;
        log$j.info("resumable from disk (process restarted)", args.sessionId);
      }
    }
    const spawnCwd = args.cwd ?? this.opts.cwd;
    const abortController = new AbortController();
    const aggregator = new SdkPartialAggregator(internalTurnId);
    const backgroundTasks = new ClaudeBackgroundTaskState();
    let sawStreamEvents = false;
    const pendingApprovals = /* @__PURE__ */ new Map();
    const queue = [];
    const waker = { resolve: null };
    const pushEvent = (event) => {
      queue.push(event);
      waker.resolve?.();
    };
    const canUseTool = async (toolName, input, options2) => {
      if (toolName === "ask_user" || toolName === "mcp__catmax__ask_user") {
        return { behavior: "allow", updatedInput: input };
      }
      const request = claudePermissionToApprovalRequest(toolName, input, {
        displayName: options2.displayName,
        description: options2.description,
        decisionReason: options2.decisionReason,
        title: options2.title
      });
      const requestId = `${internalTurnId}:${randomUUID()}`;
      const decisionAction = await new Promise((resolve2) => {
        pendingApprovals.set(requestId, { resolve: resolve2, suggestions: options2.suggestions });
        pushEvent({
          type: "approval_requested",
          turnId: internalTurnId,
          requestId,
          request,
          source: "claude"
        });
      });
      const pending = pendingApprovals.get(requestId);
      pendingApprovals.delete(requestId);
      if (decisionAction === "reject") {
        return {
          behavior: "deny",
          message: "用户拒绝",
          decisionClassification: "user_reject"
        };
      }
      if (decisionAction === "approve_always" && pending?.suggestions?.length) {
        return {
          behavior: "allow",
          updatedInput: input,
          updatedPermissions: pending.suggestions,
          decisionClassification: "user_permanent"
        };
      }
      return {
        behavior: "allow",
        updatedInput: input,
        decisionClassification: "user_temporary"
      };
    };
    const askUser = createAskUserServer((requestId, question) => {
      pushEvent({
        type: "agent_question",
        turnId: internalTurnId,
        requestId,
        question
      });
    });
    const options = {
      abortController,
      includePartialMessages: true,
      // 真正的 token 级流式（对应 CLI 的 --include-partial-messages）
      canUseTool,
      // 进程内权限回调，替代 CLI 的 --permission-prompt-tool + MCP + socket
      // ask_user 工具以 in-process MCP server 注入（type:'sdk'，SDK 自行接管 transport）
      mcpServers: {
        catmax: { type: "sdk", name: "catmax", instance: askUser.server }
      },
      // 追加 ask_user 引导语到 Claude Code 默认 system prompt（不覆盖默认 prompt）
      systemPrompt: { type: "preset", preset: "claude_code", append: ASK_USER_GUIDE }
    };
    if (spawnCwd !== void 0) options.cwd = spawnCwd;
    if (canResume) options.resume = claudeSessionId;
    if (args.model) options.model = args.model;
    if (args.effort) {
      options.effort = args.effort === "none" ? "low" : args.effort;
    }
    if (args.permissionMode) {
      options.permissionMode = args.permissionMode;
    }
    options.allowDangerouslySkipPermissions = true;
    options.env = { ...process.env, ...this.extraEnv };
    const binaryPath = this.resolveSdkBinaryPath();
    if (binaryPath !== void 0) {
      options.pathToClaudeCodeExecutable = binaryPath;
    }
    let resolveInputWait = null;
    let inputClosed = false;
    const inputQueue = [];
    const inputController = {
      close: () => {
        inputClosed = true;
        resolveInputWait?.();
      },
      push: (prompt) => {
        if (inputClosed) return false;
        inputQueue.push({
          type: "user",
          message: { role: "user", content: prompt },
          parent_tool_use_id: null,
          origin: { kind: "human" }
        });
        resolveInputWait?.();
        return true;
      }
    };
    async function* inputStream() {
      yield {
        type: "user",
        message: { role: "user", content: args.prompt },
        parent_tool_use_id: null,
        origin: { kind: "human" }
      };
      while (!inputClosed) {
        while (inputQueue.length > 0) {
          yield inputQueue.shift();
        }
        if (inputClosed) break;
        await new Promise((resolve2) => {
          resolveInputWait = resolve2;
        });
        resolveInputWait = null;
      }
    }
    let sdkQuery;
    try {
      sdkQuery = query({ prompt: inputStream(), options });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log$j.error("query() creation failed:", msg);
      inputController.close();
      yield {
        type: "error",
        turnId: internalTurnId,
        message: `SDK query 启动失败: ${msg}`,
        recoverable: false
      };
      yield { type: "turn_completed", turnId: internalTurnId, status: "error" };
      return;
    }
    const ctx2 = {
      query: sdkQuery,
      backgroundTasks,
      abortController,
      pushEvent,
      pendingApprovals,
      interrupted: false,
      sessionId: args.sessionId,
      inputController,
      askUser: {
        respondQuestion: askUser.respondQuestion,
        rejectAll: askUser.rejectAll
      }
    };
    this.turnContexts.set(internalTurnId, ctx2);
    const streamDone = { value: false, error: null };
    void (async () => {
      let terminalQueued = false;
      try {
        for await (const msg of sdkQuery) {
          if (terminalQueued) continue;
          const events = this.processSdkMessage(
            msg,
            internalTurnId,
            args.sessionId,
            aggregator,
            backgroundTasks,
            () => {
              sawStreamEvents = true;
            },
            sawStreamEvents
          );
          for (const ev of events) pushEvent(ev);
          if (events.some((event) => event.type === "turn_completed")) {
            terminalQueued = true;
            inputController.close();
          }
        }
        if (!terminalQueued) {
          if (backgroundTasks.isCancelling()) {
            pushEvent({
              type: "turn_completed",
              turnId: internalTurnId,
              status: "interrupted",
              usage: backgroundTasks.accumulatedUsage()
            });
          } else {
            pushEvent({
              type: "error",
              turnId: internalTurnId,
              message: "Claude SDK stream ended before a terminal result",
              recoverable: false
            });
            pushEvent({
              type: "turn_completed",
              turnId: internalTurnId,
              status: "error",
              usage: backgroundTasks.accumulatedUsage()
            });
          }
          terminalQueued = true;
        }
        if (!this.modelsCache) {
          try {
            const init = await sdkQuery.initializationResult();
            if (init.models && init.models.length > 0) {
              this.modelsCache = init.models;
              log$j.info("cached", init.models.length, "models from initializationResult");
            }
          } catch (e) {
            log$j.debug("initializationResult for models cache failed:", e);
          }
        }
      } catch (e) {
        streamDone.error = e instanceof Error ? e : new Error(String(e));
        if (!terminalQueued) {
          if (backgroundTasks.isCancelling()) {
            pushEvent({
              type: "turn_completed",
              turnId: internalTurnId,
              status: "interrupted",
              usage: backgroundTasks.accumulatedUsage()
            });
          } else {
            pushEvent({
              type: "error",
              turnId: internalTurnId,
              message: streamDone.error.message,
              recoverable: false
            });
            pushEvent({
              type: "turn_completed",
              turnId: internalTurnId,
              status: "error",
              usage: backgroundTasks.accumulatedUsage()
            });
          }
        }
      } finally {
        streamDone.value = true;
        waker.resolve?.();
      }
    })();
    let terminalYielded = false;
    try {
      while (!streamDone.value || queue.length > 0) {
        while (queue.length > 0) {
          const event = queue.shift();
          yield event;
          if (event.type === "turn_completed") terminalYielded = true;
        }
        if (!streamDone.value) {
          await new Promise((resolve2) => {
            waker.resolve = resolve2;
          });
          waker.resolve = null;
        }
      }
    } finally {
      inputController.close();
      this.turnContexts.delete(internalTurnId);
      for (const [, pending] of pendingApprovals) pending.resolve("reject");
      pendingApprovals.clear();
      askUser.rejectAll();
      void askUser.server.close().catch((e) => log$j.debug("ask_user server close failed:", e));
      if (!streamDone.value && !terminalYielded) {
        ctx2.interrupted = true;
        abortController.abort();
      }
    }
  }
  // ============ SDK 消息分发 ============
  /**
   * 处理一条 SDKMessage，返回要 emit 的 TurnEvent[]。
   * 对应 CLI 时代 adapter.ts 的 onChunk 分发逻辑。
   */
  processSdkMessage(msg, turnId, sessionId, aggregator, backgroundTasks, markStreamed, sawStreamEvents) {
    const events = [];
    if (msg.type === "system") {
      switch (msg.subtype) {
        case "background_tasks_changed":
        case "task_started":
        case "task_progress":
        case "task_notification": {
          for (const task of backgroundTasks.handle(msg)) {
            events.push({ type: "background_task_updated", turnId, task });
          }
          return events;
        }
      }
    }
    if (isSdkInitMessage(msg)) {
      const sid = sdkSystemSessionId(msg);
      if (sid) {
        this.sessionIdMap.set(sessionId, sid);
        this.resumableSessions.add(sessionId);
        try {
          this.opts.onRealSessionId?.(sessionId, sid);
        } catch (e) {
          log$j.warn("onRealSessionId callback failed:", e);
        }
      }
      return events;
    }
    if (isSdkPartialMessage(msg)) {
      markStreamed();
      const partialEvents = aggregator.push(msg);
      events.push(...partialEvents);
      return events;
    }
    if (isSdkAssistantMessage(msg)) {
      if (sawStreamEvents) return events;
      for (const ev of sdkAssistantToEvents(msg, turnId)) {
        events.push(ev);
      }
      return events;
    }
    if (isSdkUserMessage(msg)) {
      for (const task of backgroundTasks.handleUserMessage(msg)) {
        events.push({ type: "background_task_updated", turnId, task });
      }
      events.push(...sdkUserToolResultToEvents(msg, turnId));
      return events;
    }
    if (isSdkResultMessage(msg)) {
      if (sawStreamEvents) {
        events.push(...aggregator.flushPendingToolUse());
      }
      if (backgroundTasks.classifyResult(msg) === "intermediate") {
        log$j.debug("keeping Claude turn open for background tasks", {
          turnId,
          activeTaskIds: backgroundTasks.activeTaskIds()
        });
        return events;
      }
      const resultEvent = sdkResultToEvent(
        msg,
        turnId,
        backgroundTasks.accumulatedUsage(),
        backgroundTasks.isCancelling() ? "interrupted" : void 0
      );
      if (resultEvent.type === "turn_completed" && resultEvent.status === "error") {
        events.push({
          type: "error",
          turnId,
          message: `claude turn ended with error (subtype: ${msg.subtype})`,
          recoverable: false
        });
      }
      events.push(resultEvent);
      return events;
    }
    return events;
  }
  /**
   * 运行中热切换 model/effort/permissionMode。
   *
   * 依赖 SDK streaming-input 模式下 Query 的 control 方法：
   * - model → setModel()：当前 turn 的下一次 model 调用起生效
   * - permissionMode → setPermissionMode()：立即生效
   * - effort → applyFlagSettings({ effortLevel })：下一 turn 生效
   *
   * 每项独立 try/catch，失败只 log warn 不抛（部分成功优于全失败）。
   */
  async updateTurnConfig(turnId, config) {
    const ctx2 = this.turnContexts.get(turnId);
    if (!ctx2) {
      log$j.debug("updateTurnConfig: no context for turn (already completed?)", turnId);
      return;
    }
    if (config.model !== void 0) {
      try {
        await ctx2.query.setModel(config.model);
        log$j.info("hot-swap model →", config.model);
      } catch (e) {
        log$j.warn("setModel hot-swap failed:", e);
      }
    }
    if (config.permissionMode !== void 0) {
      try {
        await ctx2.query.setPermissionMode(config.permissionMode);
        log$j.info("hot-swap permissionMode →", config.permissionMode);
      } catch (e) {
        log$j.warn("setPermissionMode hot-swap failed:", e);
      }
    }
    if (config.effort !== void 0) {
      try {
        const effortLevel = config.effort === "none" ? "low" : config.effort;
        await ctx2.query.applyFlagSettings({ effortLevel });
        log$j.info("hot-swap effort →", effortLevel, "(下一 turn 生效)");
      } catch (e) {
        log$j.warn("applyFlagSettings(effort) hot-swap failed:", e);
      }
    }
  }
  async steer(turnId, prompt) {
    const ctx2 = this.turnContexts.get(turnId);
    if (!ctx2 || ctx2.interrupted) {
      log$j.debug("steer: no active context for turn", turnId);
      return;
    }
    if (!ctx2.inputController.push(prompt)) {
      log$j.debug("steer: input already closed for turn", turnId);
    }
  }
  async interrupt(turnId) {
    const ctx2 = this.turnContexts.get(turnId);
    if (!ctx2) {
      log$j.debug("interrupt: no context for turn (already completed?)", turnId);
      return;
    }
    if (ctx2.interrupted) return;
    ctx2.interrupted = true;
    const activeTaskIds = ctx2.backgroundTasks.activeTaskIds();
    for (const task of ctx2.backgroundTasks.markCancelling()) {
      ctx2.pushEvent({ type: "background_task_updated", turnId, task });
    }
    const stopResults = await Promise.allSettled(
      activeTaskIds.map((taskId) => ctx2.query.stopTask(taskId))
    );
    stopResults.forEach((result, index) => {
      if (result.status === "rejected") {
        log$j.warn("stopTask failed:", activeTaskIds[index], result.reason);
      }
    });
    try {
      await ctx2.query.interrupt();
    } catch (e) {
      log$j.warn("query.interrupt() failed, falling back to abort:", e);
      ctx2.abortController.abort();
    }
  }
  async respondApproval(decision) {
    const colonIdx = decision.requestId.lastIndexOf(":");
    if (colonIdx < 0) {
      log$j.warn("respondApproval: invalid requestId format", decision.requestId);
      return;
    }
    const turnId = decision.requestId.slice(0, colonIdx);
    const ctx2 = this.turnContexts.get(turnId);
    if (!ctx2) {
      log$j.warn("respondApproval: no context for turn", turnId);
      return;
    }
    const pending = ctx2.pendingApprovals.get(decision.requestId);
    if (!pending) {
      log$j.warn("respondApproval: no pending approval for", decision.requestId);
      return;
    }
    ctx2.pendingApprovals.delete(decision.requestId);
    pending.resolve(decision.action);
  }
  /**
   * 响应 agent 的问题（ask_user 工具）：把用户答案 resolve 给阻塞中的 handler，
   * handler 把它作为 tool_result 回流给模型。turnId 用来定位 turn context。
   */
  async respondQuestion(args) {
    const ctx2 = this.turnContexts.get(args.turnId);
    if (!ctx2) {
      log$j.warn("respondQuestion: no context for turn", args.turnId);
      return;
    }
    ctx2.askUser.respondQuestion(args.requestId, args.answer);
  }
  // ============ binary 路径解析（ASAR 打包支持） ============
  /**
   * 解析 SDK bundled binary 的磁盘路径。
   * - dev 模式：返回 undefined，让 SDK 通过 import.meta.url + createRequire 自行 resolve
   *   （PoC 验证：pnpm 的 .pnpm 结构能让 SDK 正确找到 binary）
   * - packaged 模式：返回 app.asar.unpacked 里的真实路径
   *   （PoC 验证：electron-builder 不会自动收集 optionalDependencies 的平台包，
   *    必须配 asarUnpack，再显式传 pathToClaudeCodeExecutable 绕过 resolve 链）
   */
  resolveSdkBinaryPath() {
    if (!app.isPackaged) return void 0;
    const platform = `${process.platform}-${process.arch}`;
    const candidate = join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      `@anthropic-ai/claude-agent-sdk-${platform}`,
      "claude"
    );
    if (existsSync(candidate)) return candidate;
    log$j.warn(
      "packaged mode but SDK binary not found at expected unpacked path; SDK resolve may fail:",
      candidate
    );
    return void 0;
  }
}
const jsonRpcRequestSchema = objectType({
  method: stringType(),
  id: unionType([numberType(), stringType()]),
  params: unknownType().optional()
});
const jsonRpcResponseSchema = objectType({
  id: unionType([numberType(), stringType()]),
  result: unknownType().optional(),
  error: objectType({
    code: numberType(),
    message: stringType(),
    data: unknownType().optional()
  }).optional()
});
const jsonRpcNotificationSchema = objectType({
  method: stringType(),
  params: unknownType()
});
const jsonRpcMessageSchema = unionType([
  jsonRpcRequestSchema,
  jsonRpcResponseSchema,
  jsonRpcNotificationSchema
]);
objectType({
  clientInfo: objectType({
    name: stringType(),
    title: stringType().optional(),
    version: stringType()
  }).optional(),
  capabilities: objectType({
    experimentalApi: booleanType().optional(),
    optOutNotificationMethods: arrayType(stringType()).optional()
  }).optional()
});
const granularApprovalPolicySchema = objectType({
  granular: objectType({
    mcp_elicitations: booleanType(),
    rules: booleanType(),
    sandbox_approval: booleanType(),
    request_permissions: booleanType().optional(),
    skill_approval: booleanType().optional()
  })
});
const approvalPolicySchema = unionType([stringType(), granularApprovalPolicySchema]);
objectType({
  cwd: stringType().optional(),
  model: stringType().optional(),
  sandbox: stringType().optional(),
  approvalPolicy: approvalPolicySchema.optional()
});
objectType({
  threadId: stringType(),
  input: unionType([stringType(), arrayType(unknownType())]).optional(),
  approvalPolicy: approvalPolicySchema.optional(),
  sandboxPolicy: unknownType().optional(),
  model: stringType().optional(),
  effort: stringType().optional()
});
const turnStartedParamsSchema = objectType({
  turn: objectType({
    id: stringType(),
    status: stringType(),
    items: arrayType(unknownType()).default([])
  })
});
const turnCompletedParamsSchema = objectType({
  turn: objectType({
    id: stringType(),
    status: enumType(["completed", "interrupted", "failed"]),
    items: arrayType(unknownType()).default([]),
    error: unknownType().optional()
  })
});
const agentMessageDeltaParamsSchema = objectType({
  itemId: stringType(),
  delta: stringType()
});
const reasoningDeltaParamsSchema = objectType({
  itemId: stringType(),
  delta: stringType()
});
const commandExecutionItemSchema = objectType({
  type: literalType("command_execution"),
  id: stringType(),
  command: stringType(),
  cwd: stringType().optional(),
  status: stringType(),
  commandActions: arrayType(unknownType()).optional(),
  aggregatedOutput: stringType().nullish(),
  exitCode: numberType().nullish(),
  durationMs: numberType().nullish()
});
const fileChangeItemSchema = objectType({
  type: literalType("file_change"),
  id: stringType(),
  changes: arrayType(
    objectType({
      path: stringType(),
      kind: stringType(),
      diff: stringType().optional()
    })
  ),
  status: stringType()
});
const camelCommandExecutionItemSchema = commandExecutionItemSchema.extend({
  type: literalType("commandExecution")
});
const camelFileChangeItemSchema = fileChangeItemSchema.extend({
  type: literalType("fileChange")
});
const agentMessageItemSchema = objectType({
  type: literalType("agent_message"),
  id: stringType(),
  text: stringType(),
  phase: enumType(["commentary", "final_answer"]).nullish()
});
const camelAgentMessageItemSchema = agentMessageItemSchema.extend({
  type: literalType("agentMessage")
});
const reasoningItemSchema = objectType({
  type: literalType("reasoning"),
  id: stringType(),
  summary: arrayType(unknownType()).default([]),
  content: arrayType(unknownType()).default([])
});
const textElementSchema = objectType({
  byteRange: objectType({ start: numberType(), end: numberType() }),
  placeholder: stringType().nullable()
}).passthrough();
const codexUserInputSchema = unionType([
  objectType({
    type: literalType("text"),
    text: stringType(),
    text_elements: arrayType(textElementSchema).optional()
  }).passthrough(),
  objectType({ type: literalType("image"), url: stringType(), detail: stringType().optional() }).passthrough(),
  objectType({ type: literalType("localImage"), path: stringType(), detail: stringType().optional() }).passthrough(),
  objectType({ type: literalType("skill"), name: stringType(), path: stringType() }).passthrough(),
  objectType({ type: literalType("mention"), name: stringType(), path: stringType() }).passthrough(),
  objectType({ type: literalType("input_text"), text: stringType() }).passthrough(),
  objectType({
    type: literalType("input_image"),
    image_url: stringType(),
    detail: stringType().optional()
  }).passthrough()
]);
const userMessageContentSchema = unionType([
  stringType(),
  arrayType(unionType([codexUserInputSchema, unknownType()]))
]);
const userMessageItemSchema = objectType({
  type: literalType("user_message"),
  id: stringType(),
  content: userMessageContentSchema.default([])
}).passthrough();
const camelUserMessageItemSchema = userMessageItemSchema.extend({
  type: literalType("userMessage")
});
const mcpToolCallItemSchema = objectType({
  type: literalType("mcp_tool_call"),
  id: stringType(),
  server: stringType(),
  tool: stringType(),
  status: stringType(),
  arguments: unknownType().optional(),
  result: unknownType().optional(),
  error: stringType().optional()
});
const camelMcpToolCallItemSchema = mcpToolCallItemSchema.extend({
  type: literalType("mcpToolCall")
});
const customToolCallItemSchema = objectType({
  type: literalType("custom_tool_call"),
  id: stringType(),
  call_id: stringType().optional(),
  name: stringType(),
  input: stringType().optional(),
  status: stringType().optional()
});
const codexItemSchema = unionType([
  commandExecutionItemSchema,
  camelCommandExecutionItemSchema,
  fileChangeItemSchema,
  camelFileChangeItemSchema,
  agentMessageItemSchema,
  camelAgentMessageItemSchema,
  reasoningItemSchema,
  userMessageItemSchema,
  camelUserMessageItemSchema,
  mcpToolCallItemSchema,
  camelMcpToolCallItemSchema,
  customToolCallItemSchema,
  // 未知 item 类型用 passthrough 接住（不阻塞流）
  objectType({ type: stringType(), id: stringType() }).passthrough()
]);
const itemStartedParamsSchema = objectType({
  threadId: stringType().optional(),
  itemId: stringType().optional(),
  item: codexItemSchema
});
const itemCompletedParamsSchema = objectType({
  threadId: stringType().optional(),
  itemId: stringType().optional(),
  item: codexItemSchema
});
const commandExecutionOutputDeltaParamsSchema = objectType({
  threadId: stringType().optional(),
  turnId: stringType().optional(),
  itemId: stringType(),
  delta: stringType()
});
const fileChangePatchUpdatedParamsSchema = objectType({
  threadId: stringType().optional(),
  turnId: stringType().optional(),
  itemId: stringType(),
  changes: arrayType(
    objectType({
      path: stringType(),
      kind: unknownType(),
      diff: stringType().optional()
    })
  )
});
const turnDiffUpdatedParamsSchema = objectType({
  threadId: stringType().optional(),
  turnId: stringType().optional(),
  diff: stringType()
});
objectType({
  includeHidden: booleanType().optional()
});
const modelListResultSchema = objectType({
  // 实测字段名是 data（不是 README 写的 models）；passthrough 容忍未知字段
  data: arrayType(
    objectType({
      id: stringType(),
      // 上游 model id，目前同 id；保留兼容未来分离的情况
      model: stringType().optional(),
      // camelCase（不是 README 写的 display_name）
      displayName: stringType().optional(),
      description: stringType().optional(),
      // 对象数组，每个含 reasoningEffort + description
      supportedReasoningEfforts: arrayType(
        objectType({
          reasoningEffort: stringType(),
          description: stringType().optional()
        }).passthrough()
      ).optional(),
      defaultReasoningEffort: stringType().optional(),
      // isDefault（不是 README 写的 default）
      isDefault: booleanType().optional()
    }).passthrough()
  ).default([]),
  nextCursor: unknownType().optional()
}).passthrough();
const commandApprovalParamsSchema = objectType({
  itemId: stringType(),
  threadId: stringType(),
  turnId: stringType(),
  reason: stringType().optional(),
  command: stringType().optional(),
  cwd: stringType().optional(),
  commandActions: arrayType(unknownType()).optional(),
  availableDecisions: arrayType(stringType()).optional()
});
const fileChangeApprovalParamsSchema = objectType({
  itemId: stringType(),
  threadId: stringType(),
  turnId: stringType(),
  reason: stringType().optional()
});
const mcpServerElicitationContextSchema = objectType({
  threadId: stringType(),
  turnId: stringType().nullable(),
  serverName: stringType()
});
const mcpServerElicitationPayloadSchema = discriminatedUnionType("mode", [
  objectType({
    mode: literalType("form"),
    message: stringType(),
    requestedSchema: unknownType(),
    _meta: unknownType().nullable()
  }).passthrough(),
  objectType({
    mode: literalType("openai/form"),
    message: stringType(),
    requestedSchema: unknownType(),
    _meta: unknownType().nullable()
  }).passthrough(),
  objectType({
    mode: literalType("url"),
    message: stringType(),
    url: stringType(),
    elicitationId: stringType(),
    _meta: unknownType().nullable()
  }).passthrough()
]);
const mcpServerElicitationRequestParamsSchema = mcpServerElicitationContextSchema.and(
  mcpServerElicitationPayloadSchema
);
function checkCliHealth(binary, args = ["--version"]) {
  let result;
  try {
    result = spawnSync(binary, args, {
      encoding: "utf-8",
      timeout: 5e3,
      shell: false
      // 不走 shell，避免 shell 转义 + 更快
    });
  } catch (e) {
    const code = e?.code;
    return {
      ok: false,
      error: code === "ENOENT" ? "not-installed" : "spawn-error"
    };
  }
  if (result.error) {
    const code = result.error.code;
    return {
      ok: false,
      error: code === "ENOENT" ? "not-installed" : "spawn-error"
    };
  }
  if (result.signal) {
    return {
      ok: false,
      error: result.signal === "SIGKILL" ? "killed-by-os" : "spawn-error",
      signal: result.signal
    };
  }
  if (result.status === null && result.signal === null) {
    return { ok: false, error: "timeout" };
  }
  if (result.status !== 0) {
    const out = { ok: false, error: "non-zero-exit" };
    if (result.status !== null) out.exitCode = result.status;
    return out;
  }
  const stdout = result.stdout;
  const version = (stdout ?? "").trim();
  const base = { ok: true };
  if (version) base.version = version;
  return base;
}
const log$i = logger.domain("spawner");
class RealProcessSpawner {
  spawn(opts) {
    log$i.info("spawning", opts.command, opts.args.join(" "));
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.on("error", (err) => {
      log$i.error("spawn error:", err);
    });
    return {
      child,
      write: (data) => child.stdin?.write(data),
      endInput: () => child.stdin?.end(),
      kill: (signal) => child.kill(signal),
      pid: child.pid
    };
  }
}
function contextBlocks(items, idPrefix) {
  return items.map((item, index) => ({
    id: `${idPrefix}-context-${index}`,
    type: "context",
    ...item
  }));
}
const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD_PREFIX = "*** Add File: ";
const DELETE_PREFIX = "*** Delete File: ";
const UPDATE_PREFIX = "*** Update File: ";
function v4PatchToCodexFileChanges(input) {
  const sections = splitV4PatchSections(input);
  return sections.map((s) => {
    const diffLines = [s.headerLine, ...s.bodyLines];
    const diff = diffLines.join("\n");
    const { additions, deletions } = countV4Stats(s);
    const kind = s.kind === "add" ? "add" : s.kind === "delete" ? "delete" : "update";
    return { path: s.path, kind, diff, stats: { additions, deletions } };
  });
}
function splitV4PatchSections(patch) {
  if (!patch.includes(BEGIN)) return [];
  const lines = patch.split("\n");
  const sections = [];
  let i = 0;
  while (i < lines.length && lines[i] !== BEGIN) i++;
  i++;
  while (i < lines.length) {
    const line = lines[i];
    if (line === END || line === BEGIN) break;
    let kind = null;
    let prefix = "";
    if (line.startsWith(ADD_PREFIX)) {
      kind = "add";
      prefix = ADD_PREFIX;
    } else if (line.startsWith(DELETE_PREFIX)) {
      kind = "delete";
      prefix = DELETE_PREFIX;
    } else if (line.startsWith(UPDATE_PREFIX)) {
      kind = "update";
      prefix = UPDATE_PREFIX;
    }
    if (kind) {
      const path = line.slice(prefix.length).trim();
      i++;
      const start = i;
      while (i < lines.length && !isSectionHeader(lines[i])) i++;
      sections.push({
        path,
        kind,
        headerLine: line,
        bodyLines: lines.slice(start, i)
      });
    } else {
      i++;
    }
  }
  return sections;
}
function countV4Stats(section) {
  let additions = 0;
  let deletions = 0;
  for (const line of section.bodyLines) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}
function isSectionHeader(line) {
  return line.startsWith("*** ") || line === END;
}
function codexItemToToolCallInfo(item) {
  const type = normalizeItemType$1(item.type);
  switch (type) {
    case "command_execution": {
      const cmd = item.command;
      return {
        kind: "shell_command",
        title: cmd.slice(0, 80),
        detail: cmd
      };
    }
    case "file_change": {
      const fc = item;
      const paths = fc.changes.map((c) => c.path).slice(0, 5).join(", ");
      const summary = `${fc.changes.length} file(s): ${paths}`;
      const unifiedDiff = fc.changes.filter((c) => c.diff).map((c) => c.diff).join("\n");
      return {
        kind: "file_edit",
        title: summary.slice(0, 80),
        // detail 保留作为 fallback（前端没有 edit 字段或解析失败时用）
        detail: fc.changes.map((c) => `--- ${c.path} (${c.kind}) ---
${c.diff ?? ""}`).join("\n"),
        ...unifiedDiff ? { edit: { type: "unified_diff", filePath: paths, diff: unifiedDiff } } : {}
      };
    }
    case "mcp_tool_call": {
      const mcp = item;
      return {
        kind: "mcp",
        title: `${mcp.server}/${mcp.tool}`,
        ...mcp.arguments !== void 0 ? { detail: JSON.stringify(mcp.arguments, null, 2) } : {}
      };
    }
    case "custom_tool_call": {
      const raw = item;
      if (raw.name !== "apply_patch") return null;
      const input = typeof raw.input === "string" ? raw.input : "";
      if (!input) return null;
      const changes = v4PatchToCodexFileChanges(input);
      const paths = changes.map((c) => c.path).slice(0, 5).join(", ");
      const summary = `${changes.length} file(s): ${paths}`;
      return {
        kind: "file_edit",
        title: summary.slice(0, 80),
        detail: input,
        edit: { type: "unified_diff", filePath: paths, diff: input }
      };
    }
    default:
      return null;
  }
}
function normalizeItemType$1(type) {
  return {
    userMessage: "user_message",
    agentMessage: "agent_message",
    commandExecution: "command_execution",
    fileChange: "file_change",
    mcpToolCall: "mcp_tool_call",
    dynamicToolCall: "dynamic_tool_call",
    collabToolCall: "collab_tool_call",
    webSearch: "web_search",
    imageView: "image_view",
    contextCompaction: "context_compaction"
  }[type] ?? type;
}
function codexItemToContentBlock(item) {
  const activityBlock = codexItemToActivityBlock(item);
  if (activityBlock) return activityBlock;
  const raw = item;
  const type = normalizeItemType$1(item.type);
  if (type === "agent_message") {
    const phase = raw.phase === "commentary" || raw.phase === "final_answer" ? raw.phase : void 0;
    return {
      id: `${item.id}-text`,
      type: "text",
      text: String(raw.text ?? ""),
      ...phase ? { phase } : {}
    };
  }
  if (type === "plan") {
    return { id: item.id, type: "plan", text: String(raw.text ?? "") };
  }
  if (type === "context_compaction") {
    return { id: item.id, type: "compact_divider" };
  }
  if (type === "web_search") {
    const query2 = String(raw.query ?? "");
    return {
      id: item.id,
      type: "tool_call",
      info: {
        kind: "web",
        title: query2 ? `Web search: ${query2}` : "Web search",
        web: { type: "search", query: query2 }
      },
      status: "completed"
    };
  }
  if (type === "image_view") {
    const path = String(raw.path ?? "");
    return {
      id: item.id,
      type: "tool_call",
      info: { kind: "file_read", title: `View image: ${path}`, detail: path },
      status: "completed"
    };
  }
  if (type === "dynamic_tool_call" || type === "collab_tool_call") {
    const tool = String(raw.tool ?? type);
    const detail = raw.arguments ?? raw.prompt;
    return {
      id: item.id,
      type: "tool_call",
      info: {
        kind: type === "collab_tool_call" ? "task" : "other",
        title: tool,
        ...detail !== void 0 ? { detail: JSON.stringify(detail, null, 2) } : {}
      },
      status: raw.status === "inProgress" ? "running" : "completed"
    };
  }
  return null;
}
function codexItemToActivityBlock(item, options = {}) {
  const activities = codexItemToActivities(item);
  if (activities.length === 0) return null;
  const durationMs = activities.reduce((total, activity) => total + (activity.durationMs ?? 0), 0);
  return {
    id: item.id,
    type: "codex_activity",
    status: aggregateActivityStatus(activities),
    activities,
    ...options.defaultCollapsed !== void 0 ? { defaultCollapsed: options.defaultCollapsed } : {},
    ...durationMs > 0 ? { durationMs } : {}
  };
}
function codexItemToActivities(item) {
  const raw = item;
  const type = normalizeItemType$1(item.type);
  const status = normalizeActivityStatus(raw.status);
  const durationMs = numberOrUndefined(raw.durationMs);
  if (type === "command_execution") {
    const command = String(raw.command ?? "");
    const cwd = stringOrUndefined(raw.cwd);
    const output = stringOrUndefined(raw.aggregatedOutput);
    const actions = Array.isArray(raw.commandActions) ? raw.commandActions : [];
    if (actions.length === 0) {
      return [
        {
          id: item.id,
          kind: "command",
          command,
          status,
          ...cwd ? { cwd } : {},
          ...output !== void 0 ? { output } : {},
          ...durationMs !== void 0 ? { durationMs } : {}
        }
      ];
    }
    return actions.map(
      (action, index) => commandActionToActivity(action, {
        // 第一条沿用 item id，确保旧版本 item/started 缺 commandActions、但
        // item/completed 补齐 actions 时仍能原位替换，而不是生成重复命令。
        id: index === 0 ? item.id : `${item.id}-${index}`,
        parentCommand: command,
        status,
        ...cwd !== void 0 ? { cwd } : {},
        ...output !== void 0 ? { output } : {},
        ...durationMs !== void 0 ? { durationMs } : {}
      })
    );
  }
  if (type === "file_change") {
    const changes = Array.isArray(raw.changes) ? raw.changes.map((change) => normalizeFileChange(change)) : [];
    return [
      {
        id: item.id,
        kind: "file_change",
        status,
        changes,
        ...durationMs !== void 0 ? { durationMs } : {}
      }
    ];
  }
  if (type === "custom_tool_call" && raw.name === "apply_patch") {
    const input = typeof raw.input === "string" ? raw.input : "";
    const changes = v4PatchToCodexFileChanges(input);
    if (changes.length === 0) return [];
    return [
      {
        id: item.id,
        kind: "file_change",
        status,
        changes,
        ...durationMs !== void 0 ? { durationMs } : {}
      }
    ];
  }
  if (type === "mcp_tool_call") {
    const title = [raw.server, raw.tool].filter(Boolean).map(String).join("/");
    return [
      {
        id: item.id,
        kind: "mcp",
        title: title || "MCP",
        status,
        ...raw.arguments !== void 0 ? { detail: JSON.stringify(raw.arguments, null, 2) } : {},
        ...durationMs !== void 0 ? { durationMs } : {}
      }
    ];
  }
  if (type === "dynamic_tool_call") {
    return [
      {
        id: item.id,
        kind: "dynamic_tool",
        title: String(raw.tool ?? "Tool"),
        status,
        ...raw.arguments !== void 0 ? { detail: JSON.stringify(raw.arguments, null, 2) } : {},
        ...durationMs !== void 0 ? { durationMs } : {}
      }
    ];
  }
  if (type === "collab_tool_call") {
    return [
      {
        id: item.id,
        kind: "collab_tool",
        title: String(raw.tool ?? "Subagent"),
        status,
        ...raw.prompt !== void 0 ? { detail: String(raw.prompt) } : {},
        ...durationMs !== void 0 ? { durationMs } : {}
      }
    ];
  }
  if (type === "web_search") {
    const query2 = String(raw.query ?? "");
    return [
      {
        id: item.id,
        kind: "web_search",
        title: query2 || "Web search",
        status: "completed"
      }
    ];
  }
  if (type === "image_view") {
    return [
      {
        id: item.id,
        kind: "image_view",
        title: String(raw.path ?? ""),
        status: "completed"
      }
    ];
  }
  return [];
}
function diffStats(diff) {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}
function aggregateActivityStatus(activities) {
  if (activities.some((activity) => activity.status === "running")) return "running";
  if (activities.some((activity) => activity.status === "failed")) return "failed";
  return "completed";
}
function commandActionToActivity(action, context) {
  const command = action.command ?? context.parentCommand;
  const common = {
    id: context.id,
    command,
    status: context.status,
    ...context.durationMs !== void 0 ? { durationMs: context.durationMs } : {}
  };
  switch (action.type) {
    case "read":
      return {
        ...common,
        kind: "file_read",
        path: action.path ?? action.name ?? "",
        ...action.name ? { name: action.name } : {}
      };
    case "listFiles":
      return {
        ...common,
        kind: "file_list",
        ...action.path ? { path: action.path } : {}
      };
    case "search":
      return {
        ...common,
        kind: "search",
        ...action.query ? { query: action.query } : {},
        ...action.path ? { path: action.path } : {}
      };
    default:
      return {
        ...common,
        kind: "command",
        ...context.cwd ? { cwd: context.cwd } : {},
        ...context.output !== void 0 ? { output: context.output } : {}
      };
  }
}
function normalizeFileChange(value) {
  const change = typeof value === "object" && value !== null ? value : {};
  const diff = stringOrUndefined(change.diff);
  const rawKind = change.kind;
  let kind = "unknown";
  let movePath;
  if (typeof rawKind === "string") {
    if (rawKind === "add" || rawKind === "delete" || rawKind === "update") kind = rawKind;
    if (rawKind === "edit") kind = "update";
  } else if (typeof rawKind === "object" && rawKind !== null) {
    const kindObject = rawKind;
    const type = kindObject.type;
    if (type === "add" || type === "delete" || type === "update") kind = type;
    movePath = stringOrUndefined(kindObject.move_path);
  }
  return {
    path: String(change.path ?? ""),
    kind,
    ...movePath ? { movePath } : {},
    ...diff !== void 0 ? { diff } : {},
    stats: diffStats(diff)
  };
}
function normalizeActivityStatus(value) {
  if (value === "inProgress" || value === "in_progress" || value === "running") return "running";
  if (value === "failed" || value === "declined" || value === "cancelled") return "failed";
  return "completed";
}
function stringOrUndefined(value) {
  return typeof value === "string" ? value : void 0;
}
function numberOrUndefined(value) {
  return typeof value === "number" ? value : void 0;
}
function codexCommandToOutput(item) {
  const exitCode = typeof item.exitCode === "number" ? item.exitCode : void 0;
  const ok = exitCode !== void 0 ? exitCode === 0 : item.status === "completed";
  const summary = exitCode !== void 0 ? exitCode === 0 ? `exit 0 (${item.durationMs ?? 0}ms)` : `exit ${exitCode}` : item.status;
  return {
    ok,
    summary,
    ...typeof item.aggregatedOutput === "string" ? { output: item.aggregatedOutput } : {}
  };
}
function codexFileChangeToOutput(item) {
  const ok = item.status === "completed";
  return {
    ok,
    summary: ok ? `${item.changes.length} file(s) edited` : `failed: ${item.status}`,
    output: item.changes.map((c) => `--- ${c.path} (${c.kind}) ---
${c.diff ?? ""}`).join("\n")
  };
}
function codexApprovalToRequest(kind, command, cwd, reason, changes) {
  if (kind === "shell_command") {
    const cmd = command ?? "(unknown command)";
    return {
      kind,
      title: cmd.slice(0, 100),
      detail: `$ ${cmd}${cwd ? `
(cwd: ${cwd})` : ""}${reason ? `

${reason}` : ""}`,
      riskLevel: assessRisk(kind, cmd)
    };
  }
  if (kind === "file_edit") {
    const paths = "(no paths)";
    return {
      kind,
      title: `Edit ${0} file(s)`,
      detail: "",
      riskLevel: assessRisk(kind, paths)
    };
  }
  return {
    kind,
    title: reason ?? "Unknown MCP call",
    detail: reason ?? "",
    riskLevel: "medium"
  };
}
function ensureItemId(codexItemId, fallback) {
  return codexItemId ?? fallback;
}
function normalizeItemType(type) {
  const camelMap = {
    userMessage: "user_message",
    agentMessage: "agent_message",
    fileChange: "file_change",
    commandExecution: "command_execution",
    mcpToolCall: "mcp_tool_call"
  };
  return camelMap[type] ?? type;
}
function extractTurns(readResult) {
  const thread = readResult.thread;
  return thread?.turns ?? [];
}
function extractItems(turn) {
  const items = turn.items ?? [];
  return items.filter((item) => {
    return typeof item === "object" && item !== null && "type" in item && "id" in item;
  });
}
function codexTurnsToMessages(turns) {
  const messages = [];
  let currentAssistant = null;
  for (const turn of turns) {
    const turnId = turn?.id ?? randomUUID();
    const turnDurationMs = extractTurnDurationMs(turn);
    const items = extractItems(turn);
    let durationAssigned = false;
    for (const item of items) {
      const isReasoning = normalizeItemType(item.type) === "reasoning";
      const reasoningDurationMs = isReasoning && !durationAssigned ? turnDurationMs : void 0;
      if (reasoningDurationMs !== void 0) durationAssigned = true;
      const msg = mapItemToMessage(item, turnId, reasoningDurationMs);
      if (!msg) continue;
      if (msg.role === "assistant") {
        if (currentAssistant) messages.push(currentAssistant);
        currentAssistant = msg;
      } else if (msg.role === "user") {
        if (currentAssistant) {
          messages.push(currentAssistant);
          currentAssistant = null;
        }
        messages.push(msg);
      } else if (msg.role === "tool") {
        if (currentAssistant) {
          messages.push(currentAssistant);
          currentAssistant = null;
        }
        messages.push(msg);
      }
    }
  }
  if (currentAssistant) messages.push(currentAssistant);
  return messages;
}
function mapItemToMessage(item, turnId, turnDurationMs) {
  const itemId = item.id;
  const itemType = normalizeItemType(item.type);
  switch (itemType) {
    case "user_message": {
      const content = item.content;
      const userContent = extractCodexUserContent(content, itemId);
      if (matchInterruptMarker(userContent.text)) {
        return {
          id: itemId,
          role: "user",
          turnId,
          blocks: [{ id: `${itemId}-text`, type: "text", text: userContent.text.trim() }],
          textBlocks: [{ id: `${itemId}-text`, text: userContent.text.trim(), kind: "text" }],
          createdAt: 0
        };
      }
      const { text, blocks: contextTags } = extractContextTags(
        userContent.text,
        sharedContextTagExtractors
      );
      if (!text && contextTags.length === 0 && userContent.blocks.length === 0) return null;
      const blocks = [
        ...contextBlocks(contextTags, itemId),
        ...userContent.blocks,
        ...text ? [{ id: `${itemId}-text`, type: "text", text }] : []
      ];
      return {
        id: itemId,
        role: "user",
        turnId,
        blocks,
        textBlocks: text ? [{ id: `${itemId}-text`, text, kind: "text" }] : [],
        ...contextTags.length > 0 ? { contextBlocks: contextTags } : {},
        createdAt: 0
        // codex 不在 item 里返回 createdAt，UI 用 turns 的时间
      };
    }
    case "agent_message": {
      const agentMessage = item;
      const text = agentMessage.text ?? "";
      const phase = agentMessage.phase ?? void 0;
      return {
        id: itemId,
        role: "assistant",
        turnId,
        blocks: text ? [{ id: `${itemId}-text`, type: "text", text, ...phase ? { phase } : {} }] : [],
        textBlocks: text ? [{ id: `${itemId}-text`, text, kind: "text" }] : [],
        toolBlocks: [],
        createdAt: 0
      };
    }
    case "reasoning": {
      const summary = extractReasoningSummary(item.summary);
      return {
        id: itemId,
        role: "assistant",
        turnId,
        blocks: summary ? [
          {
            id: `${itemId}-reasoning`,
            type: "reasoning",
            text: summary,
            completedLabel: "已处理",
            defaultCollapsed: true,
            ...turnDurationMs !== void 0 ? { durationMs: turnDurationMs } : {}
          }
        ] : [],
        textBlocks: summary ? [{ id: `${itemId}-reasoning`, text: summary, kind: "reasoning" }] : [],
        toolBlocks: [],
        createdAt: 0
      };
    }
    case "command_execution":
    case "file_change":
    case "mcp_tool_call":
    case "custom_tool_call": {
      const activityBlock = codexItemToActivityBlock(item, { defaultCollapsed: true });
      if (activityBlock) {
        return {
          id: itemId,
          role: "tool",
          turnId,
          blocks: [activityBlock],
          textBlocks: [],
          toolBlocks: [],
          createdAt: 0
        };
      }
      const toolInfo = codexItemToToolCallInfo(item);
      if (!toolInfo) return null;
      let output;
      if (itemType === "command_execution") {
        output = codexCommandToOutput(item);
      } else if (itemType === "file_change") {
        output = codexFileChangeToOutput(item);
      }
      return {
        id: itemId,
        role: "tool",
        turnId,
        textBlocks: [],
        toolBlocks: [
          {
            id: itemId,
            info: toolInfo,
            status: output?.ok === false ? "failed" : "completed",
            ...output !== void 0 ? { output } : {}
          }
        ],
        createdAt: 0
      };
    }
    default: {
      const block = codexItemToActivityBlock(item, { defaultCollapsed: true }) ?? codexItemToContentBlock(item);
      if (!block) return null;
      return {
        id: itemId,
        role: "assistant",
        turnId,
        blocks: [block],
        textBlocks: [],
        toolBlocks: [],
        createdAt: 0
      };
    }
  }
}
const IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp"
]);
function extractCodexUserContent(content, idPrefix = "codex-user") {
  const inputs = Array.isArray(content) ? content : [content];
  const textParts = [];
  const blocks = [];
  let pendingImage;
  const addInput = (input) => {
    const existing = (input.path ? blocks.find((block2) => block2.path === input.path) : void 0) ?? (input.url ? blocks.find((block2) => block2.url === input.url) : void 0);
    if (existing) {
      Object.assign(existing, input);
      return existing;
    }
    const block = {
      id: `${idPrefix}-input-${blocks.length}`,
      type: "codex_user_input",
      ...input
    };
    blocks.push(block);
    return block;
  };
  const addText = (value) => {
    const imageMarker = parseImageMarker(value);
    if (imageMarker) {
      pendingImage = imageMarker;
      if (imageMarker.path) {
        addInput({
          kind: isImageReference(imageMarker.path) ? "image" : "file",
          ...imageMarker
        });
      }
      return;
    }
    if (/^\s*<\/image>\s*$/.test(value)) {
      pendingImage = void 0;
      return;
    }
    const envelope = parseLegacyUserEnvelope(value);
    if (envelope) {
      for (const attachment of envelope.attachments) {
        addInput({
          kind: isImageReference(attachment.path) ? "image" : "file",
          ...attachment
        });
      }
      if (envelope.prompt) textParts.push(envelope.prompt);
      return;
    }
    if (value.trim()) textParts.push(value);
  };
  for (const input of inputs) {
    if (typeof input === "string") {
      addText(input);
      continue;
    }
    if (typeof input !== "object" || input === null) continue;
    const value = input;
    const type = typeof value.type === "string" ? value.type : "";
    if ((type === "text" || type === "input_text" || !type) && typeof value.text === "string") {
      addText(value.text);
      continue;
    }
    if ((type === "image" || type === "input_image") && pendingImage) {
      const url = typeof value.url === "string" ? value.url : typeof value.image_url === "string" ? value.image_url : void 0;
      if (url) {
        addInput({
          kind: "image",
          ...pendingImage,
          url,
          ...typeof value.detail === "string" ? { detail: value.detail } : {}
        });
      }
      pendingImage = void 0;
      continue;
    }
    if (type === "image" && typeof value.url === "string") {
      addInput({
        kind: "image",
        url: value.url,
        ...typeof value.detail === "string" ? { detail: value.detail } : {}
      });
      continue;
    }
    if (type === "input_image" && typeof value.image_url === "string") {
      addInput({
        kind: "image",
        url: value.image_url,
        ...typeof value.detail === "string" ? { detail: value.detail } : {}
      });
      continue;
    }
    if (type === "localImage" && typeof value.path === "string") {
      addInput({
        kind: "image",
        path: value.path,
        name: fileName(value.path),
        ...typeof value.detail === "string" ? { detail: value.detail } : {}
      });
      continue;
    }
    if ((type === "skill" || type === "mention") && typeof value.name === "string" && typeof value.path === "string") {
      addInput({ kind: type, name: value.name, path: value.path });
      continue;
    }
    if (typeof value.text === "string") {
      addText(value.text);
    } else if (typeof value.image_url === "string") {
      addInput({ kind: "image", url: value.image_url });
    }
  }
  return {
    text: textParts.join("\n").trim(),
    blocks
  };
}
function parseImageMarker(value) {
  const match = value.trim().match(/^<image\s+name=\[([^\]]+)\]\s+path=(?:"([^"]+)"|'([^']+)')\s*>$/);
  if (!match) return null;
  return {
    ...match[1] ? { name: match[1] } : {},
    ...match[2] || match[3] ? { path: match[2] ?? match[3] } : {}
  };
}
function parseLegacyUserEnvelope(value) {
  const normalized = value.replace(/\r\n/g, "\n");
  const header = normalized.match(/^\s*# Files mentioned by the user:\s*$/m);
  const request = normalized.match(/^## My request for Codex:\s*$/m);
  if (!header || header.index === void 0 || !request || request.index === void 0) return null;
  if (normalized.slice(0, header.index).trim()) return null;
  if (request.index <= header.index) return null;
  const attachmentSection = normalized.slice(header.index + header[0].length, request.index);
  const lines = attachmentSection.split("\n");
  const attachments = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^##\s+(.+?):(?:\s+(.*))?$/);
    if (!match) continue;
    let path = match[2]?.trim();
    if (!path) {
      const next = lines.slice(index + 1).find((line) => line.trim());
      if (next && !next.trim().startsWith("#") && !next.trim().startsWith("<")) {
        path = next.trim();
      }
    }
    if (!path) continue;
    attachments.push({ ...match[1] ? { name: match[1].trim() } : {}, path });
  }
  return {
    attachments,
    prompt: normalized.slice(request.index + request[0].length).trim()
  };
}
function isImageReference(reference) {
  if (reference.startsWith("data:image/")) return true;
  const clean = reference.split(/[?#]/, 1)[0];
  const extension = clean.includes(".") ? clean.slice(clean.lastIndexOf(".") + 1).toLowerCase() : "";
  return IMAGE_EXTENSIONS.has(extension);
}
function fileName(reference) {
  const clean = reference.replace(/[/\\]+$/, "");
  return clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1) || reference;
}
function extractReasoningSummary(summary) {
  if (typeof summary === "string") return summary;
  if (!Array.isArray(summary)) return "";
  return summary.map((s) => {
    if (typeof s === "string") return s;
    if (typeof s === "object" && s !== null && "text" in s) {
      return String(s.text);
    }
    return "";
  }).join("\n").trim();
}
function mergeAssistantAndToolMessages(messages) {
  const result = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      const last = result[result.length - 1];
      if (last?.role === "assistant" && last.turnId === msg.turnId) {
        if (!last.toolBlocks) last.toolBlocks = [];
        last.toolBlocks.push(...msg.toolBlocks ?? []);
        mergeCodexActivityBlocks(last, msg);
        continue;
      }
      if ((msg.blocks ?? []).some((block) => block.type === "codex_activity")) {
        result.push({ ...msg, role: "assistant" });
        continue;
      }
    }
    result.push(msg);
  }
  return result;
}
function mergeCodexActivityBlocks(target, source) {
  const incoming = (source.blocks ?? []).filter(
    (block) => block.type === "codex_activity"
  );
  if (incoming.length === 0) return;
  if (!target.blocks) target.blocks = [];
  for (const block of incoming) {
    const last = target.blocks[target.blocks.length - 1];
    if (last?.type === "codex_activity") {
      last.activities.push(...block.activities);
      last.status = last.status === "failed" || block.status === "failed" ? "failed" : last.status === "running" || block.status === "running" ? "running" : "completed";
      last.durationMs = (last.durationMs ?? 0) + (block.durationMs ?? 0);
    } else {
      target.blocks.push(block);
    }
  }
}
function extractTurnDurationMs(turn) {
  if (typeof turn !== "object" || turn === null) return void 0;
  const raw = turn;
  if (typeof raw.durationMs === "number") return raw.durationMs;
  if (typeof raw.startedAt === "number" && typeof raw.completedAt === "number") {
    return Math.max(0, (raw.completedAt - raw.startedAt) * 1e3);
  }
  return void 0;
}
const log$h = logger.domain("codex-protocol");
function parseFrame(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    log$h.warn("failed to parse JSON line:", trimmed.slice(0, 200), e);
    return null;
  }
  const result = jsonRpcMessageSchema.safeParse(parsed);
  if (!result.success) {
    log$h.warn("frame failed schema validation:", result.error.issues.slice(0, 3));
    return null;
  }
  return result.data;
}
function classifyMessage(msg) {
  if ("method" in msg && "id" in msg) {
    const req = jsonRpcRequestSchema.safeParse(msg);
    if (req.success) return { kind: "server-request", message: req.data };
  }
  if ("id" in msg && !("method" in msg)) {
    const res = jsonRpcResponseSchema.safeParse(msg);
    if (res.success) return { kind: "response", message: res.data };
  }
  if ("method" in msg && !("id" in msg)) {
    const notif = jsonRpcNotificationSchema.safeParse(msg);
    if (notif.success) return { kind: "notification", message: notif.data };
  }
  return null;
}
class LineBuffer {
  buffer = "";
  /** 推入新字节，返回完整的行（不含换行符） */
  push(chunk) {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    const lines = [];
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim()) lines.push(line);
    }
    return lines;
  }
  /** 取出剩余未完成行（用于 stream 关闭时 flush） */
  flush() {
    if (this.buffer.trim()) {
      const rest = this.buffer;
      this.buffer = "";
      return rest;
    }
    return null;
  }
}
function encodeRequest(method, params, id) {
  const frame = {
    method,
    id: id ?? randomUUID(),
    params
  };
  return JSON.stringify(frame);
}
function encodeNotification(method, params) {
  const frame = { method, params };
  return JSON.stringify(frame);
}
function encodeResponse(id, result) {
  const frame = { id, result };
  return JSON.stringify(frame);
}
const log$g = logger.domain("codex-adapter");
async function readModelFromRollout(rolloutPath) {
  if (!rolloutPath) return null;
  try {
    const stream = createReadStream(rolloutPath, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.includes("turn_context")) continue;
        const parsed = JSON.parse(line);
        if (parsed.type === "turn_context" && typeof parsed.payload?.model === "string") {
          return parsed.payload.model;
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  } catch (e) {
    const code = e.code;
    if (code !== "ENOENT") {
      log$g.warn("readModelFromRollout failed", rolloutPath, e);
    }
  }
  return null;
}
class CodexAdapter {
  id = "codex";
  capabilities = CODEX_CAPABILITIES;
  opts;
  spawner;
  proc = null;
  lineBuffer = new LineBuffer();
  nextRequestId = 0;
  pendingRequests = /* @__PURE__ */ new Map();
  pendingApprovals = /* @__PURE__ */ new Map();
  initialized = false;
  /**
   * 进行中的 initialize Promise——并发去重。
   *
   * 多个调用者（listModels / startSession / reconcile 等）可能同时触发
   * ensureInitialized()。没有复用时，两个调用都检查 this.initialized===false
   * 后各自发 initialize 请求，codex 会拒绝第二个返回 "Already initialized" error，
   * 导致进程被 rejectAllPending 杀死、所有后续 RPC 失败。
   * 复用同一个 Promise：第一个调用 spawn+握手，其他调用 await 同一个 Promise。
   */
  initializePromise = null;
  /**
   * model/list 缓存——避免每次 listModels() 都 RPC 往返。
   * 存的是 Promise（而不是已 resolve 的值），这样并发调用者共享同一次 RPC：
   *   - initialize() 预取 + 第一次 listModels() 同时触发时，只发一次 model/list
   *   - 失败时把缓存清空（设回 null），下次调用会重试
   * 进程退出时也清空（账户可能换了）。
   */
  cachedModelsPromise = null;
  /** 当前 turn 的事件 sink（同一时刻只跑一个 turn） */
  currentSink = null;
  /** 内部 turnId → codex turnId 映射 */
  turnIdMap = /* @__PURE__ */ new Map();
  constructor(opts = {}) {
    this.opts = opts;
    this.spawner = opts.spawner ?? new RealProcessSpawner();
  }
  /** 运行时设置 binaryPath（settings 加载后注入；不影响已 spawn 的进程） */
  setBinaryPath(path) {
    if (this.initialized) {
      log$g.warn("setBinaryPath called after initialize — will take effect on next re-init");
    }
    this.opts = { ...this.opts, binaryPath: path };
  }
  /** 读当前 binaryPath（applySettings 用来对比是否变化决定要不要清模型缓存） */
  getBinaryPath() {
    return this.opts.binaryPath;
  }
  /** 注入额外的子进程环境变量（HTTPS_PROXY 等）；不影响已 spawn 的进程 */
  setExtraEnv(env) {
    this.extraEnv = env;
  }
  extraEnv = {};
  // ============ 生命周期 ============
  async initialize() {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.doInitialize();
    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = null;
    }
  }
  async doInitialize() {
    if (!this.proc) {
      const binary = this.opts.binaryPath ?? "codex";
      this.proc = this.spawner.spawn({
        command: binary,
        args: ["app-server"],
        env: { ...this.extraEnv },
        ...this.opts.cwd !== void 0 ? { cwd: this.opts.cwd } : {}
      });
      this.proc.child.stdout?.on("data", (chunk) => this.onStdoutData(chunk));
      this.proc.child.stderr?.on("data", (chunk) => {
        const rawText = chunk.toString("utf-8").trim();
        const text = rawText.replace(/\x1B\[[0-9;]*m/g, "");
        log$g.warn("codex stderr:", text);
        const apiErrMatch = text.match(/error=http (\d+)[^:]*:\s*(.+)/);
        if (apiErrMatch) {
          const code = apiErrMatch[1] ?? "";
          const detail = (apiErrMatch[2] ?? "").slice(0, 300);
          const friendly = friendlyApiError(code, detail);
          log$g.warn(
            "codex API error detected",
            "hasSink=",
            !!this.currentSink,
            "hasTurnId=",
            !!this.findCurrentTurnId()
          );
          if (this.currentSink) {
            const turnId = this.findCurrentTurnId() ?? "";
            log$g.warn("codex API error → pushing error event:", friendly);
            this.currentSink.push({
              type: "error",
              turnId,
              message: friendly,
              recoverable: false
            });
            this.currentSink.push({
              type: "turn_completed",
              turnId,
              status: "error"
            });
          }
        }
      });
      this.proc.child.on("exit", (code, signal) => {
        log$g.warn("codex exited:", { code, signal });
        this.initialized = false;
        this.cachedModelsPromise = null;
        this.rejectAllPending("codex process exited");
      });
    }
    try {
      await this.sendRequest("initialize", {
        clientInfo: { name: "catmax-app", title: "catmax", version: "0.1.0" },
        // openai/form MCP elicitation（Computer Use 的应用授权）属于扩展能力；
        // 显式声明后 app-server 才能把该类请求交给 CatMax 渲染。
        capabilities: { experimentalApi: true }
      });
    } catch (e) {
      this.killAndClearProc();
      throw e;
    }
    this.sendNotification("initialized", {});
    this.initialized = true;
    log$g.info("initialized");
    void this.listModels().catch((e) => log$g.warn("model/list prefetch failed:", e));
  }
  /** kill 当前子进程并清空引用（用于 initialize 失败回滚） */
  killAndClearProc() {
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
      }
      this.proc = null;
    }
    this.lineBuffer = new LineBuffer();
    this.initialized = false;
    this.cachedModelsPromise = null;
  }
  /** reject 所有 pending request（用于进程意外退出） */
  rejectAllPending(reason) {
    for (const [id, { reject }] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      reject(new BackendError("protocol", reason));
    }
  }
  async healthCheck() {
    const binary = this.opts.binaryPath ?? "codex";
    return checkCliHealth(binary, ["--version"]);
  }
  async dispose() {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.initialized = false;
    this.cachedModelsPromise = null;
    this.pendingRequests.clear();
    this.pendingApprovals.clear();
    log$g.info("disposed");
  }
  getCapabilities() {
    return this.capabilities;
  }
  async listModels() {
    if (this.cachedModelsPromise) return this.cachedModelsPromise;
    this.cachedModelsPromise = (async () => {
      try {
        await this.ensureInitialized();
        const result = await this.sendRequest("model/list", {});
        const parsed = modelListResultSchema.parse(result);
        const allowedEfforts = new Set(this.capabilities.supportedEfforts);
        const models = parsed.data.map((m) => {
          const supportedEfforts = m.supportedReasoningEfforts?.map((e) => e.reasoningEffort).filter((e) => allowedEfforts.has(e)).map((e) => e);
          return {
            id: m.id,
            // 实测 codex 返回的 displayName 跟 id 一模一样（"gpt-5.2-codex"），
            // 用户看着像 model id——保留 displayName 优先，没有再回退到 id。
            displayName: m.displayName ?? m.id,
            ...m.description !== void 0 ? { description: m.description } : {},
            ...m.isDefault === true ? { isDefault: true } : {},
            ...supportedEfforts !== void 0 && supportedEfforts.length > 0 ? { supportedEfforts } : {}
          };
        });
        if (models.length > 0) {
          const hasDefault = models.some((m) => m.isDefault);
          if (!hasDefault) models[0].isDefault = true;
        }
        return models;
      } catch (e) {
        this.cachedModelsPromise = null;
        log$g.warn("listModels failed, returning empty:", e);
        return [];
      }
    })();
    return this.cachedModelsPromise;
  }
  /**
   * 解析默认模型 id —— 用户没在下拉框选时，startSession/startTurn 用这个。
   * 优先用 listModels() 返回的 isDefault 项；都没有（账户没登录/网络不通）就抛错，
   * 由上层显示明确错误，而不是发一个过时/无效的 model id 给 codex。
   */
  async resolveDefaultModel() {
    const models = await this.listModels();
    const def = models.find((m) => m.isDefault) ?? models[0];
    if (def) return def.id;
    throw new BackendError(
      "protocol",
      "无法从 codex 获取可用模型列表——账户未登录 / 网络不通 / codex 版本不兼容"
    );
  }
  invalidateModelsCache() {
    this.cachedModelsPromise = null;
  }
  // ============ 会话 ============
  async startSession(args) {
    await this.ensureInitialized();
    const model = args.model ?? await this.resolveDefaultModel();
    const result = await this.sendRequest("thread/start", {
      cwd: args.cwd,
      model,
      approvalPolicy: permissionToApproval(args.permissionMode)
    });
    const thread = result.thread;
    if (!thread?.id) {
      throw new BackendError("protocol", "thread/start did not return thread.id");
    }
    return {
      sessionId: randomUUID(),
      backendThreadId: thread.id
    };
  }
  async listSessions(cwd) {
    await this.ensureInitialized();
    await this.ensureInitialized();
    const allSourceKinds = [
      "cli",
      "vscode",
      "exec",
      "appServer",
      "subAgent",
      "subAgentReview",
      "subAgentCompact",
      "subAgentThreadSpawn",
      "subAgentOther",
      "unknown"
    ];
    const params = { sourceKinds: allSourceKinds };
    if (cwd !== void 0) params.cwd = cwd;
    const all = [];
    let cursor = null;
    for (let page = 0; page < 50; page++) {
      if (cursor) params.cursor = cursor;
      const result = await this.sendRequest("thread/list", params);
      const resp = result;
      const threads = resp.data ?? [];
      const pageMeta = threads.map((t) => ({
        id: t.id ?? "",
        title: t.name ?? t.preview ?? null,
        updatedAtSec: t.updatedAt ?? 0,
        cwd: t.cwd ?? void 0,
        rolloutPath: t.path ?? null
      }));
      const models = await Promise.all(pageMeta.map((m) => readModelFromRollout(m.rolloutPath)));
      for (let i = 0; i < pageMeta.length; i++) {
        const m = pageMeta[i];
        all.push({
          backendThreadId: m.id,
          title: m.title,
          lastActiveAt: m.updatedAtSec > 0 ? m.updatedAtSec * 1e3 : Date.now(),
          // 具体 model 从 rollout jsonl 的 turn_context 行读；读不到（空会话/文件缺失）为 null，
          // UI 会 fallback 到默认 model。注意：不用 RPC 的 modelProvider（那是 "openai" 提供商，
          // 不是具体 model id，存了会导致下拉匹配不上显示"未选中"）
          model: models[i] ?? null,
          cwd: m.cwd
        });
      }
      cursor = resp.nextCursor ?? null;
      if (!cursor) break;
    }
    return all;
  }
  async deleteSession(backendThreadId) {
    const sessionsDir = join(homedir(), ".codex", "sessions");
    try {
      const entries = await readdir(sessionsDir, { recursive: true, withFileTypes: true });
      const suffix = `-${backendThreadId}.jsonl`;
      const matches = entries.filter(
        (e) => e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(suffix)
      );
      if (matches.length === 0) {
        log$g.warn("no codex rollout file found for thread", backendThreadId);
        return;
      }
      for (const ent of matches) {
        const abs = join(ent.path ?? sessionsDir, ent.name);
        await unlink(abs).catch(() => {
        });
        log$g.info("deleted codex rollout file", abs);
      }
    } catch (e) {
      const code = e.code;
      if (code === "ENOENT") return;
      log$g.warn("failed to delete codex session files", backendThreadId, e);
    }
  }
  async resumeSession(backendThreadId) {
    await this.ensureInitialized();
    await this.sendRequest("thread/resume", { threadId: backendThreadId });
    return { messages: [] };
  }
  /**
   * 读会话历史：调 thread/read 拿 turn 数组，转成 NormalizedMessage[]。
   *
   * Resume 前置：codex 是 long-running app-server，thread 状态驻留在内存里。
   * 进程重启 / idle 回收后内存里没了这个 thread，后续 turn/start 会报
   * "thread not found"。thread/read 能从 rollout 文件冷读出历史（看似成功），
   * 但它不保证 thread 已注册——所以必须在 read 之前先 thread/resume 把 thread
   * 重新装回 app-server 内存，否则用户从历史会话继续聊第二轮会失败。
   * thread/resume 幂等：对已注册的 thread 调用是无副作用的 no-op。
   */
  async getHistory(backendThreadId, cwd) {
    await this.ensureInitialized();
    try {
      await this.sendRequest("thread/resume", { threadId: backendThreadId });
    } catch (e) {
      if (isUnmaterializedThreadError(e)) {
        log$g.debug("thread not materialized before history read", backendThreadId);
      } else {
        log$g.warn("thread/resume failed before read, continuing anyway", backendThreadId, e);
      }
    }
    let result;
    try {
      result = await this.sendRequest("thread/read", {
        threadId: backendThreadId,
        includeTurns: true
      });
    } catch (e) {
      if (isUnmaterializedThreadError(e)) {
        log$g.info("history not materialized yet, returning empty", backendThreadId);
        return { messages: [] };
      }
      throw e;
    }
    const turns = extractTurns(result);
    const messages = codexTurnsToMessages(turns);
    const merged = mergeAssistantAndToolMessages(messages);
    log$g.info("history loaded", backendThreadId, merged.length, "messages");
    return { messages: merged.map(upgradeMessageBlocks) };
  }
  // ============ Turn（核心） ============
  /**
   * 启动一轮 turn。返回 AsyncIterable<TurnEvent>。
   *
   * 注意：这是 async generator——main 进程内部用 for-await 消费。
   * BackendManager 会订阅它，把事件经 IPC 推给 renderer。
   */
  async *startTurn(args) {
    await this.ensureInitialized();
    const internalTurnId = randomUUID();
    yield { type: "turn_started", turnId: internalTurnId, sessionId: args.sessionId };
    this.turnIdMap.set(internalTurnId, "");
    const state = { queue: [], resolveWait: null, done: false };
    this.currentSink = makeSink(state);
    try {
      const model = args.model ?? await this.resolveDefaultModel();
      const turnResponse = await this.sendRequest("turn/start", {
        threadId: args.sessionId,
        input: [{ type: "text", text: args.prompt }],
        model,
        ...args.effort !== void 0 ? { effort: args.effort } : {},
        approvalPolicy: permissionToApproval(args.permissionMode)
      });
      const codexTurnId = turnResponse.turn?.id;
      if (codexTurnId) {
        this.turnIdMap.set(internalTurnId, codexTurnId);
      }
    } catch (e) {
      this.currentSink = null;
      this.turnIdMap.delete(internalTurnId);
      yield {
        type: "error",
        turnId: internalTurnId,
        message: e instanceof Error ? e.message : String(e),
        recoverable: false
      };
      yield { type: "turn_completed", turnId: internalTurnId, status: "error" };
      return;
    }
    try {
      const TURN_IDLE_TIMEOUT_MS = 6e4;
      let lastEventTime = Date.now();
      while (true) {
        while (state.queue.length > 0) {
          const event = state.queue.shift();
          lastEventTime = Date.now();
          yield event;
          if (event.type === "turn_completed" || event.type === "error") {
            return;
          }
        }
        if (state.done) return;
        const remaining = TURN_IDLE_TIMEOUT_MS - (Date.now() - lastEventTime);
        if (remaining <= 0) {
          yield {
            type: "error",
            turnId: internalTurnId,
            message: 'codex 60 秒内没有响应——可能是网络问题（api.openai.com / chatgpt.com 不可达）或 ChatGPT token 过期。请在终端跑 `codex exec "test"` 验证。',
            recoverable: false
          };
          yield { type: "turn_completed", turnId: internalTurnId, status: "error" };
          return;
        }
        await new Promise((resolve2) => {
          state.resolveWait = resolve2;
          setTimeout(resolve2, Math.min(remaining, 5e3));
        });
        state.resolveWait = null;
      }
    } finally {
      this.currentSink = null;
      this.turnIdMap.delete(internalTurnId);
    }
  }
  // ============ 反向控制 ============
  async interrupt(turnId) {
    const codexTurnId = this.turnIdMap.get(turnId);
    if (!codexTurnId) {
      log$g.warn("interrupt: no codex turn id for", turnId);
      return;
    }
    try {
      await this.sendRequest("turn/interrupt", { turnId: codexTurnId });
    } catch (e) {
      log$g.error("interrupt failed:", e);
    }
  }
  async respondApproval(decision) {
    const pending = this.pendingApprovals.get(decision.requestId);
    if (!pending) {
      log$g.warn("respondApproval: no pending approval for", decision.requestId);
      return;
    }
    this.pendingApprovals.delete(decision.requestId);
    pending.resolve(decision.action);
  }
  async steer(turnId, prompt) {
    const codexTurnId = this.turnIdMap.get(turnId);
    if (!codexTurnId) return;
    await this.sendRequest("turn/steer", {
      turnId: codexTurnId,
      input: [{ type: "text", text: prompt }]
    });
  }
  // ============ 内部：stdin/stdout 处理 ============
  async ensureInitialized() {
    if (!this.initialized) {
      await this.initialize();
    }
  }
  /** 发 JSON-RPC 请求，等响应 */
  sendRequest(method, params) {
    if (!this.proc) {
      return Promise.reject(new BackendError("not-initialized", "process not spawned"));
    }
    const id = this.nextRequestId++;
    const frame = encodeRequest(method, params, id);
    return new Promise((resolve2, reject) => {
      this.pendingRequests.set(id, { resolve: resolve2, reject });
      this.proc.write(frame + "\n");
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new BackendError("timeout", `request ${method} timed out`));
        }
      }, 3e4);
    });
  }
  sendNotification(method, params) {
    if (!this.proc) return;
    this.proc.write(encodeNotification(method, params) + "\n");
  }
  /** stdout 数据到达，切行、解析、分发 */
  onStdoutData(chunk) {
    const lines = this.lineBuffer.push(chunk);
    for (const line of lines) {
      const msg = parseFrame(line);
      if (!msg) continue;
      const classified = classifyMessage(msg);
      if (!classified) continue;
      switch (classified.kind) {
        case "response":
          this.handleResponse(classified.message);
          break;
        case "notification":
          this.handleNotification(classified.message);
          break;
        case "server-request":
          this.handleServerRequest(classified.message);
          break;
      }
    }
  }
  handleResponse(msg) {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) return;
    this.pendingRequests.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(msg.error.message));
    } else {
      pending.resolve(msg.result);
    }
  }
  handleNotification(msg) {
    if (!this.currentSink) {
      return;
    }
    const event = this.translateNotification(msg.method, msg.params);
    if (event) {
      this.currentSink.push(event);
    }
  }
  /** 把 codex notification 转成 TurnEvent */
  translateNotification(method, params) {
    const internalTurnId = this.findCurrentTurnId();
    if (!internalTurnId) return null;
    switch (method) {
      case "turn/started": {
        const r = turnStartedParamsSchema.safeParse(params);
        if (!r.success) return null;
        const codexTurnId = r.data.turn.id;
        this.turnIdMap.set(internalTurnId, codexTurnId);
        return {
          type: "turn_started",
          turnId: internalTurnId,
          sessionId: internalTurnId
        };
      }
      case "turn/completed": {
        const r = turnCompletedParamsSchema.safeParse(params);
        if (!r.success) return null;
        const raw = r.data.turn.status;
        const status = raw === "completed" ? "completed" : raw === "interrupted" ? "interrupted" : "error";
        return { type: "turn_completed", turnId: internalTurnId, status };
      }
      case "item/agentMessage/delta": {
        const r = agentMessageDeltaParamsSchema.safeParse(params);
        if (!r.success) return null;
        return {
          type: "text_delta",
          turnId: internalTurnId,
          itemId: r.data.itemId,
          text: r.data.delta
        };
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const r = reasoningDeltaParamsSchema.safeParse(params);
        if (!r.success) return null;
        return {
          type: "reasoning_delta",
          turnId: internalTurnId,
          itemId: r.data.itemId,
          text: r.data.delta,
          completedLabel: "已处理"
        };
      }
      case "item/commandExecution/outputDelta": {
        const r = commandExecutionOutputDeltaParamsSchema.safeParse(params);
        if (!r.success) return null;
        return {
          type: "codex_activity_output_delta",
          turnId: internalTurnId,
          itemId: r.data.itemId,
          text: r.data.delta
        };
      }
      case "item/fileChange/patchUpdated": {
        const r = fileChangePatchUpdatedParamsSchema.safeParse(params);
        if (!r.success) return null;
        const block = codexItemToActivityBlock({
          type: "fileChange",
          id: r.data.itemId,
          status: "inProgress",
          changes: r.data.changes
        });
        return block ? {
          type: "content_block_upsert",
          turnId: internalTurnId,
          itemId: r.data.itemId,
          block
        } : null;
      }
      case "turn/diff/updated": {
        const r = turnDiffUpdatedParamsSchema.safeParse(params);
        if (!r.success) return null;
        return {
          type: "codex_turn_diff_updated",
          turnId: internalTurnId,
          diff: r.data.diff
        };
      }
      case "item/started": {
        const r = itemStartedParamsSchema.safeParse(params);
        if (!r.success) return null;
        return this.translateItemStarted(r.data.item, internalTurnId);
      }
      case "item/completed": {
        const r = itemCompletedParamsSchema.safeParse(params);
        if (!r.success) return null;
        return this.translateItemCompleted(r.data.item, internalTurnId);
      }
      default:
        return null;
    }
  }
  translateItemStarted(item, turnId) {
    const block = codexItemToContentBlock(item);
    if (block) {
      return { type: "content_block_upsert", turnId, itemId: item.id, block };
    }
    const itemId = ensureItemId(item.id, randomUUID());
    const toolInfo = codexItemToToolCallInfo(item);
    if (toolInfo) {
      return {
        type: "tool_call_started",
        turnId,
        itemId,
        tool: toolInfo
      };
    }
    return null;
  }
  translateItemCompleted(item, turnId) {
    const block = codexItemToContentBlock(item);
    if (block) {
      return {
        type: "content_block_upsert",
        turnId,
        itemId: item.id,
        block,
        completed: true
      };
    }
    const itemId = ensureItemId(item.id, randomUUID());
    const toolInfo = codexItemToToolCallInfo(item);
    if (toolInfo) {
      const raw = item;
      const ok = !raw.error && raw.status !== "failed";
      return {
        type: "tool_call_completed",
        turnId,
        itemId,
        output: {
          ok,
          summary: raw.error ?? raw.status ?? (ok ? "completed" : "failed"),
          ...raw.result !== void 0 ? { output: JSON.stringify(raw.result, null, 2) } : {}
        }
      };
    }
    return null;
  }
  /** server 主动发的请求（approval）—— 需要响应 */
  handleServerRequest(msg) {
    if (msg.method === "item/commandExecution/requestApproval") {
      const r = commandApprovalParamsSchema.safeParse(msg.params);
      if (!r.success) return;
      const internalTurnId = this.findCurrentTurnId();
      if (!internalTurnId) return;
      const requestId = String(msg.id);
      const request = codexApprovalToRequest(
        "shell_command",
        r.data.command,
        r.data.cwd,
        r.data.reason
      );
      this.registerApproval(requestId, internalTurnId, msg.id, request);
    } else if (msg.method === "item/fileChange/requestApproval") {
      const r = fileChangeApprovalParamsSchema.safeParse(msg.params);
      if (!r.success) return;
      const internalTurnId = this.findCurrentTurnId();
      if (!internalTurnId) return;
      const requestId = String(msg.id);
      const request = codexApprovalToRequest("file_edit", void 0, void 0, r.data.reason);
      this.registerApproval(requestId, internalTurnId, msg.id, request);
    } else if (msg.method === "mcpServer/elicitation/request") {
      const r = mcpServerElicitationRequestParamsSchema.safeParse(msg.params);
      if (!r.success) {
        log$g.warn("invalid MCP elicitation request:", r.error.message);
        this.writeServerResponse(msg.id, {
          action: "cancel",
          content: null,
          _meta: null
        });
        return;
      }
      const internalTurnId = this.findCurrentTurnId();
      if (!internalTurnId) {
        this.writeServerResponse(msg.id, {
          action: "cancel",
          content: null,
          _meta: null
        });
        return;
      }
      if (!canRenderMcpElicitation(r.data)) {
        log$g.warn("unsupported MCP elicitation form:", r.data.mode, r.data.serverName);
        this.writeServerResponse(msg.id, {
          action: "cancel",
          content: null,
          _meta: null
        });
        return;
      }
      this.registerMcpElicitation(String(msg.id), internalTurnId, msg.id, r.data);
    } else {
      log$g.warn("unhandled server request:", msg.method);
    }
  }
  /** 注册 pending approval，推 approval_requested 给 UI，等用户决策后写响应 */
  registerApproval(requestId, internalTurnId, rawMsgId, request) {
    const promise = new Promise((resolve2) => {
      this.pendingApprovals.set(requestId, {
        resolve: resolve2,
        turnId: internalTurnId,
        requestId
      });
    });
    this.currentSink?.push({
      type: "approval_requested",
      turnId: internalTurnId,
      requestId,
      request
    });
    void promise.then((action) => {
      const decision = action === "approve" ? "accept" : action === "approve_always" ? "acceptForSession" : "decline";
      if (this.proc) {
        this.proc.write(encodeResponse(rawMsgId, { decision }) + "\n");
      }
    });
  }
  /** 把 MCP elicitation 映射为 CatMax 权限面板，并按 MCP 协议返回 action/content/_meta。 */
  registerMcpElicitation(requestId, internalTurnId, rawMsgId, params) {
    if (params.mode === "url") return;
    const persistence = extractMcpPersistence(params._meta);
    const request = {
      kind: "mcp",
      title: params.message,
      detail: formatMcpElicitationDetail(params),
      riskLevel: "medium",
      displayName: params.serverName === "computer-use" ? "Computer Use" : params.serverName,
      description: `MCP server：${params.serverName}`,
      decisionReason: "MCP server 请求操作本机应用，需要由你明确授权。",
      ...persistence.length > 0 ? { approvalPersistence: persistence } : {}
    };
    const promise = new Promise((resolve2) => {
      this.pendingApprovals.set(requestId, {
        resolve: resolve2,
        turnId: internalTurnId,
        requestId
      });
    });
    this.currentSink?.push({
      type: "approval_requested",
      turnId: internalTurnId,
      requestId,
      request
    });
    void promise.then((action) => {
      if (action === "reject") {
        this.writeServerResponse(rawMsgId, {
          action: "decline",
          content: null,
          _meta: null
        });
        return;
      }
      const selectedPersistence = action === "approve_always" ? persistence.includes("always") ? "always" : persistence.includes("session") ? "session" : null : null;
      this.writeServerResponse(rawMsgId, {
        action: "accept",
        content: buildMcpElicitationContent(
          params.requestedSchema,
          selectedPersistence === "always"
        ),
        _meta: selectedPersistence ? { persist: selectedPersistence } : null
      });
    });
  }
  writeServerResponse(id, result) {
    if (this.proc) {
      this.proc.write(encodeResponse(id, result) + "\n");
    }
  }
  findCurrentTurnId() {
    for (const [internal] of this.turnIdMap) {
      return internal;
    }
    return null;
  }
}
function isUnmaterializedThreadError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("no rollout found for thread id") || message.includes("is not materialized yet");
}
function friendlyApiError(httpCode, detail) {
  const modelMatch = detail.match(/'([^']+)' model is not supported/);
  if (modelMatch) {
    return `OpenAI 拒绝了请求：${modelMatch[1]} model 不能用于当前账户。
可能原因：你登录的是 ChatGPT 免费账户（chatgpt_plan_type=free），免费账户不支持 codex 调 LLM API。
解决：登录 ChatGPT Plus / Pro / Team 账户，或换用 API Key 登录（codex login --api-key）。`;
  }
  if (httpCode === "401") {
    return `OpenAI 认证失败（401）。ChatGPT token 可能已过期——请在终端跑 \`codex login\` 重新登录。`;
  }
  if (httpCode === "429") {
    return `OpenAI 限流（429）。请求过于频繁或配额耗尽，稍后再试。`;
  }
  if (httpCode.startsWith("5")) {
    return `OpenAI 服务器错误（${httpCode}）。稍后再试。`;
  }
  return `OpenAI API 错误（HTTP ${httpCode}）：${detail}`;
}
function permissionToApproval(mode) {
  switch (mode) {
    case "default":
      return "untrusted";
    case "acceptEdits":
    case "auto":
      return "on-request";
    case "plan":
      return "never";
    case "dontAsk":
    case "bypassPermissions":
      return {
        granular: {
          mcp_elicitations: true,
          rules: false,
          sandbox_approval: false,
          request_permissions: false,
          skill_approval: false
        }
      };
    default:
      return void 0;
  }
}
function extractMcpPersistence(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return [];
  const persist = meta.persist;
  const values = Array.isArray(persist) ? persist : typeof persist === "string" ? [persist] : [];
  return values.filter(
    (value) => value === "session" || value === "always"
  );
}
function formatMcpElicitationDetail(params) {
  return params.message;
}
function canRenderMcpElicitation(params) {
  if (params.mode === "url") return false;
  if (!params.requestedSchema || typeof params.requestedSchema !== "object" || Array.isArray(params.requestedSchema)) {
    return false;
  }
  const schema = params.requestedSchema;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return required.every((field) => field === "allowPersistentApproval");
}
function buildMcpElicitationContent(requestedSchema, allowPersistentApproval) {
  if (!requestedSchema || typeof requestedSchema !== "object" || Array.isArray(requestedSchema)) {
    return {};
  }
  const properties = requestedSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return {};
  if (!Object.prototype.hasOwnProperty.call(properties, "allowPersistentApproval")) return {};
  return { allowPersistentApproval };
}
function makeSink(state) {
  return {
    push(event) {
      state.queue.push(event);
      if (event.type === "turn_completed" || event.type === "error") {
        state.done = true;
      }
      state.resolveWait?.();
    },
    close() {
      state.done = true;
      state.resolveWait?.();
    },
    done() {
      return Promise.resolve();
    }
  };
}
function validateBackendPluginManifest(manifest) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id)) {
    throw new Error(`invalid backend plugin id: ${manifest.id}`);
  }
  if (!manifest.displayName.trim()) throw new Error("backend plugin displayName is required");
  if (!manifest.version.trim()) throw new Error("backend plugin version is required");
  if (new Set(manifest.blockTypes).size !== manifest.blockTypes.length) {
    throw new Error(`backend plugin "${manifest.id}" declares duplicate block types`);
  }
  const undeclaredBlockTypes = manifest.capabilities.chat.blockTypes.filter(
    (type) => !manifest.blockTypes.includes(type)
  );
  if (undeclaredBlockTypes.length > 0) {
    throw new Error(
      `backend plugin "${manifest.id}" capabilities reference undeclared block types: ${undeclaredBlockTypes.join(", ")}`
    );
  }
}
const registry = /* @__PURE__ */ new Map();
function registerBackendPlugin(plugin) {
  validateBackendPluginManifest(plugin.manifest);
  if (registry.has(plugin.manifest.id)) {
    throw new Error(`backend plugin "${plugin.manifest.id}" is already registered`);
  }
  registry.set(plugin.manifest.id, plugin);
}
function getBackendPlugins() {
  return [...registry.values()];
}
function normalizeProxyUrl(url) {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}
function proxySettingsToEnv(proxy) {
  if (!proxy || !proxy.enabled || !proxy.url) {
    return {};
  }
  const url = normalizeProxyUrl(proxy.url);
  const env = {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    // Codex CLI (reqwest) 用 ALL_PROXY 作为兜底，配上有备无患
    ALL_PROXY: url,
    all_proxy: url
  };
  if (proxy.bypass) {
    const bypass = proxy.bypass.trim();
    if (bypass) {
      env.NO_PROXY = bypass;
      env.no_proxy = bypass;
    }
  }
  return env;
}
function parseSystemProxy(scutilOutput) {
  const get = (key) => {
    const m = scutilOutput.match(new RegExp(`${key}\\s*:\\s*(\\S+)`));
    return m ? m[1] : null;
  };
  const httpsEnable = get("HTTPSEnable") === "1";
  const httpEnable = get("HTTPEnable") === "1";
  const host = get("HTTPSProxy") ?? get("HTTPProxy");
  const port = get("HTTPSPort") ?? get("HTTPPort");
  if (!httpsEnable && !httpEnable || !host || !port) {
    return null;
  }
  const bypassMatches = Array.from(scutilOutput.matchAll(/^\s*(\d+)\s*:\s*(.+)$/gm));
  const bypassList = bypassMatches.map((m) => m[2].trim());
  const meaningful = bypassList.filter((s) => {
    if (s.match(/^(192\.168\.\d+\.\d+\/\d+|10\.\d+\.\d+\.\d+\/\d+|172\.\d+\.\d+\.\d+\/\d+)$/))
      return false;
    if (s === "127.0.0.1" || s.startsWith("127.")) return false;
    if (s === "localhost") return false;
    if (s.endsWith(".local") || s === "*.local") return false;
    if (s.endsWith(".apple.com") || s.includes("apple.com")) return false;
    return true;
  });
  return {
    enabled: true,
    url: `http://${host}:${port}`,
    bypass: meaningful.length > 0 ? meaningful.join(",") : null
  };
}
function registerBuiltinBackendPlugins() {
  const registered = new Set(getBackendPlugins().map((plugin) => plugin.manifest.id));
  if (!registered.has("codex")) {
    registerBackendPlugin({
      manifest: {
        id: "codex",
        displayName: "Codex",
        version: "1",
        blockTypes: CODEX_CAPABILITIES.chat.blockTypes,
        capabilities: CODEX_CAPABILITIES
      },
      createAdapter: () => new CodexAdapter(),
      applySettings: (adapter, settings) => {
        if (!(adapter instanceof CodexAdapter)) return;
        const binaryPath = settings.backendPaths.codex;
        if (binaryPath) {
          const changed = adapter.getBinaryPath() !== binaryPath;
          adapter.setBinaryPath(binaryPath);
          if (changed) adapter.invalidateModelsCache();
        }
        adapter.setExtraEnv(proxySettingsToEnv(settings.httpProxy));
      }
    });
  }
  if (!registered.has("claude")) {
    registerBackendPlugin({
      manifest: {
        id: "claude",
        displayName: "Claude",
        version: "1",
        blockTypes: CLAUDE_CAPABILITIES.chat.blockTypes,
        capabilities: CLAUDE_CAPABILITIES
      },
      createAdapter: (context) => new ClaudeAdapter({
        onRealSessionId: (internalId, realId) => context.onBackendThreadIdResolved("claude", internalId, realId)
      }),
      applySettings: (adapter, settings) => {
        if (!(adapter instanceof ClaudeAdapter)) return;
        const binaryPath = settings.backendPaths.claude;
        if (binaryPath) adapter.setBinaryPath(binaryPath);
        adapter.setExtraEnv(proxySettingsToEnv(settings.httpProxy));
      }
    });
  }
}
function registerMainBackendPlugins() {
  registerBuiltinBackendPlugins();
}
class DatabaseTurnRunRepository {
  constructor(database) {
    this.database = database;
  }
  save(record) {
    this.database.upsertTurnRun(record);
  }
  list(sessionId) {
    return this.database.listTurnRuns(sessionId);
  }
  listRecoverable() {
    return this.database.listRecoverableTurnRuns();
  }
  pruneCompletedBefore(timestamp) {
    return this.database.deleteTurnRunsCompletedBefore(timestamp);
  }
}
class InMemoryTurnRunRepository {
  records = /* @__PURE__ */ new Map();
  save(record) {
    this.records.set(record.id, structuredClone(record));
  }
  list(sessionId) {
    return [...this.records.values()].filter((record) => sessionId === void 0 || record.sessionId === sessionId).sort((left, right) => right.createdAt - left.createdAt).map((record) => structuredClone(record));
  }
  listRecoverable() {
    return this.list().filter((record) => {
      return record.status === "queued" || record.status === "running" || record.status === "cancelling";
    }).sort((left, right) => left.createdAt - right.createdAt);
  }
  pruneCompletedBefore(timestamp) {
    let deleted = 0;
    for (const [id, record] of this.records) {
      if (record.completedAt !== null && record.completedAt < timestamp && (record.status === "completed" || record.status === "interrupted" || record.status === "error")) {
        this.records.delete(id);
        deleted++;
      }
    }
    return deleted;
  }
}
const DEFAULT_TURN_IDLE_TIMEOUT_MS = 30 * 60 * 1e3;
const DEFAULT_CANCEL_GRACE_MS = 15 * 1e3;
const DEFAULT_TURN_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 1e3;
class PerTurnCoordinator {
  repository;
  idleTimeoutMs;
  cancelGraceMs;
  retentionMs;
  checkpointIntervalMs;
  now;
  onError;
  lanes = /* @__PURE__ */ new Map();
  aliases = /* @__PURE__ */ new Map();
  requests = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    this.repository = options.repository ?? new InMemoryTurnRunRepository();
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_TURN_IDLE_TIMEOUT_MS;
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.retentionMs = options.retentionMs ?? DEFAULT_TURN_RETENTION_MS;
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {
    });
  }
  enqueue(request) {
    if (this.aliases.has(request.id)) {
      throw new Error(`turn "${request.id}" is already coordinated`);
    }
    const createdAt = this.now();
    const record = {
      id: request.id,
      sessionId: request.sessionId,
      backend: request.backend,
      backendTurnId: null,
      status: "queued",
      backgroundTasks: [],
      createdAt,
      startedAt: null,
      lastEventAt: null,
      completedAt: null,
      error: null
    };
    const laneKey = request.laneKey ?? request.sessionId;
    const entry = {
      request,
      record,
      laneKey,
      backgroundTasks: /* @__PURE__ */ new Map(),
      requestIds: /* @__PURE__ */ new Set(),
      pendingBoundActions: [],
      terminalSeen: false,
      settled: false,
      settlePromise: null,
      interruptDispatched: false,
      idleTimer: null,
      cancelTimer: null,
      checkpointTimer: null
    };
    const lane = this.lanes.get(laneKey) ?? { active: null, queue: [] };
    this.lanes.set(laneKey, lane);
    lane.queue.push(entry);
    this.aliases.set(request.id, entry);
    this.persist(entry);
    this.startNext(laneKey);
    return this.snapshot(entry.record);
  }
  async interrupt(referenceId, reason = "用户停止任务") {
    const entry = this.aliases.get(referenceId);
    if (!entry || entry.settled) return false;
    await this.cancel(entry, reason);
    return true;
  }
  findBackend(referenceId) {
    return this.aliases.get(referenceId)?.request.backend ?? null;
  }
  findBackendByRequestId(requestId) {
    return this.requests.get(requestId)?.request.backend ?? null;
  }
  getBackendTurnId(referenceId) {
    return this.aliases.get(referenceId)?.record.backendTurnId ?? null;
  }
  /**
   * 在 adapter 的真实 turn id 建立后执行控制动作。
   *
   * Manager 用它承载 steer / hot-swap 等命令，协调器不需要知道动作的协议含义。
   * 返回 false 表示 turn 已不存在或正在取消，调用方可决定是否走旧版兼容路径。
   */
  dispatchWhenBound(referenceId, action) {
    const entry = this.aliases.get(referenceId);
    if (!entry || entry.settled || entry.terminalSeen || entry.record.status === "cancelling") {
      return false;
    }
    const backendTurnId = entry.record.backendTurnId;
    if (backendTurnId) {
      this.runBoundAction(action, backendTurnId);
    } else {
      entry.pendingBoundActions.push(action);
    }
    return true;
  }
  list(sessionId) {
    return this.repository.list(sessionId);
  }
  /**
   * App 重启时本地 SDK 进程已不存在，无法安全重连。
   * 将持久化的非终态记录推进 interrupted，保留任务快照供诊断/UI 回放。
   */
  recoverInterrupted() {
    const recoveredAt = this.now();
    const recovered = this.repository.listRecoverable().map((record) => {
      const next = {
        ...record,
        status: "interrupted",
        backgroundTasks: record.backgroundTasks.map((task) => {
          if (task.status !== "running") return task;
          return {
            ...task,
            status: "stopped",
            summary: "应用重启，后台任务已停止",
            stats: { ...task.stats, status: "stopped" }
          };
        }),
        completedAt: recoveredAt,
        lastEventAt: record.lastEventAt ?? recoveredAt,
        error: "应用重启，后台任务已失去运行进程"
      };
      this.save(next);
      return this.snapshot(next);
    });
    this.prune();
    return recovered;
  }
  prune() {
    return this.repository.pruneCompletedBefore(this.now() - this.retentionMs);
  }
  async dispose() {
    const entries = /* @__PURE__ */ new Set();
    for (const lane of this.lanes.values()) {
      if (lane.active) entries.add(lane.active);
      for (const entry of lane.queue) entries.add(entry);
    }
    const interrupts = [];
    const finishes = [];
    for (const entry of entries) {
      if (entry.settled) continue;
      if (entry.record.status === "running" || entry.record.status === "cancelling") {
        const backendTurnId = entry.record.backendTurnId;
        if (backendTurnId) {
          interrupts.push(entry.request.interrupt(backendTurnId).catch(this.onError));
        }
      }
      this.publishSyntheticCompletion(entry, "interrupted");
      finishes.push(this.finish(entry));
    }
    await Promise.allSettled([...interrupts, ...finishes]);
  }
  startNext(laneKey) {
    const lane = this.lanes.get(laneKey);
    if (!lane || lane.active) return;
    const entry = lane.queue.shift();
    if (!entry) {
      this.lanes.delete(laneKey);
      return;
    }
    if (entry.settled) {
      this.startNext(laneKey);
      return;
    }
    lane.active = entry;
    const startedAt = this.now();
    entry.record.status = "running";
    entry.record.startedAt = startedAt;
    entry.record.lastEventAt = startedAt;
    this.persist(entry);
    this.armIdleWatchdog(entry);
    void this.execute(entry);
  }
  async execute(entry) {
    try {
      await entry.request.run({
        publish: (event) => this.publish(entry, event)
      });
      if (entry.settled) return;
      if (!entry.terminalSeen) {
        if (entry.record.status === "cancelling") {
          this.publishSyntheticCompletion(entry, "interrupted");
        } else {
          this.publishSyntheticError(entry, "Backend stream ended without turn_completed");
          this.publishSyntheticCompletion(entry, "error");
        }
      }
      await this.finish(entry);
    } catch (error) {
      if (entry.settled) return;
      if (entry.record.status === "cancelling") {
        this.publishSyntheticCompletion(entry, "interrupted");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.publishSyntheticError(entry, message);
        this.publishSyntheticCompletion(entry, "error");
      }
      await this.finish(entry);
    }
  }
  publish(entry, event, bindBackendTurnId = true) {
    if (entry.settled || entry.terminalSeen) return;
    const eventAt = this.now();
    entry.record.lastEventAt = eventAt;
    const publishedEvent = event.type === "turn_completed" && entry.record.status === "cancelling" && event.status === "completed" ? { ...event, status: "interrupted" } : event;
    if (bindBackendTurnId && !entry.record.backendTurnId) {
      entry.record.backendTurnId = publishedEvent.turnId;
      this.aliases.set(publishedEvent.turnId, entry);
      if (entry.record.status === "cancelling") void this.dispatchInterrupt(entry);
      if (entry.record.status !== "cancelling" && publishedEvent.type !== "turn_completed") {
        const actions = entry.pendingBoundActions.splice(0);
        for (const action of actions) this.runBoundAction(action, publishedEvent.turnId);
      }
    }
    if (publishedEvent.type === "background_task_updated") {
      entry.backgroundTasks.set(publishedEvent.task.taskId, structuredClone(publishedEvent.task));
      entry.record.backgroundTasks = [...entry.backgroundTasks.values()];
    } else if (publishedEvent.type === "approval_requested" || publishedEvent.type === "agent_question") {
      entry.requestIds.add(publishedEvent.requestId);
      this.requests.set(publishedEvent.requestId, entry);
    } else if (publishedEvent.type === "error" && !publishedEvent.recoverable) {
      entry.record.error = publishedEvent.message;
    }
    if (publishedEvent.type === "turn_completed") {
      entry.terminalSeen = true;
      entry.record.status = publishedEvent.status;
      entry.record.completedAt = eventAt;
      this.clearTimer(entry, "idle");
      this.clearTimer(entry, "cancel");
      this.clearCheckpoint(entry);
    } else {
      this.armIdleWatchdog(entry);
    }
    if (publishedEvent.type === "turn_started" || publishedEvent.type === "background_task_updated" || publishedEvent.type === "approval_requested" || publishedEvent.type === "agent_question" || publishedEvent.type === "error" || publishedEvent.type === "turn_completed") {
      this.persist(entry);
    } else {
      this.scheduleCheckpoint(entry);
    }
    this.emit(entry, publishedEvent);
    if (publishedEvent.type === "turn_completed") void this.finish(entry);
  }
  async cancel(entry, reason) {
    if (entry.record.status === "queued") {
      entry.record.error = reason;
      this.publishSyntheticCompletion(entry, "interrupted");
      await this.finish(entry);
      return;
    }
    if (entry.record.status !== "running" && entry.record.status !== "cancelling") return;
    entry.record.status = "cancelling";
    entry.record.error = reason;
    entry.pendingBoundActions.length = 0;
    this.persist(entry);
    this.clearTimer(entry, "idle");
    this.armCancelGrace(entry);
    void this.dispatchInterrupt(entry);
  }
  async dispatchInterrupt(entry) {
    if (entry.interruptDispatched || entry.settled) return;
    const backendTurnId = entry.record.backendTurnId;
    if (!backendTurnId) return;
    entry.interruptDispatched = true;
    try {
      await entry.request.interrupt(backendTurnId);
    } catch (error) {
      this.onError(error);
    }
  }
  armIdleWatchdog(entry) {
    if (entry.terminalSeen || entry.settled || entry.record.status !== "running") return;
    this.clearTimer(entry, "idle");
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.settled || entry.terminalSeen || entry.record.status !== "running") return;
      this.publishSyntheticError(
        entry,
        `Turn produced no events for ${this.idleTimeoutMs}ms; stopping background work`
      );
      void this.cancel(entry, "后台任务长时间无事件，已自动停止");
    }, this.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }
  armCancelGrace(entry) {
    this.clearTimer(entry, "cancel");
    entry.cancelTimer = setTimeout(() => {
      entry.cancelTimer = null;
      if (entry.settled || entry.terminalSeen) return;
      this.publishSyntheticCompletion(entry, "interrupted");
      void this.finish(entry);
    }, this.cancelGraceMs);
    entry.cancelTimer.unref?.();
  }
  publishSyntheticError(entry, message) {
    this.publish(
      entry,
      {
        type: "error",
        turnId: entry.record.backendTurnId ?? entry.record.id,
        message,
        recoverable: false
      },
      false
    );
  }
  publishSyntheticCompletion(entry, status) {
    this.publish(
      entry,
      {
        type: "turn_completed",
        turnId: entry.record.backendTurnId ?? entry.record.id,
        status
      },
      false
    );
  }
  finish(entry) {
    if (entry.settlePromise) return entry.settlePromise;
    entry.settled = true;
    entry.settlePromise = this.finishOnce(entry);
    return entry.settlePromise;
  }
  async finishOnce(entry) {
    this.clearTimer(entry, "idle");
    this.clearTimer(entry, "cancel");
    this.clearCheckpoint(entry);
    if (!entry.record.completedAt) entry.record.completedAt = this.now();
    this.persist(entry);
    this.aliases.delete(entry.record.id);
    if (entry.record.backendTurnId) this.aliases.delete(entry.record.backendTurnId);
    for (const requestId of entry.requestIds) this.requests.delete(requestId);
    entry.pendingBoundActions.length = 0;
    const lane = this.lanes.get(entry.laneKey);
    if (lane) {
      if (lane.active === entry) lane.active = null;
      lane.queue = lane.queue.filter((queued) => queued !== entry);
      queueMicrotask(() => this.startNext(entry.laneKey));
    }
    try {
      await entry.request.onSettled?.(this.snapshot(entry.record));
    } catch (error) {
      this.onError(error);
    }
  }
  emit(entry, event) {
    try {
      entry.request.onEvent(event);
    } catch (error) {
      this.onError(error);
    }
  }
  runBoundAction(action, backendTurnId) {
    try {
      void Promise.resolve(action(backendTurnId)).catch(this.onError);
    } catch (error) {
      this.onError(error);
    }
  }
  persist(entry) {
    this.save(entry.record);
  }
  save(record) {
    try {
      this.repository.save(this.snapshot(record));
    } catch (error) {
      this.onError(error);
    }
  }
  snapshot(record) {
    return structuredClone(record);
  }
  scheduleCheckpoint(entry) {
    if (entry.checkpointTimer || entry.settled) return;
    entry.checkpointTimer = setTimeout(() => {
      entry.checkpointTimer = null;
      if (!entry.settled) this.persist(entry);
    }, this.checkpointIntervalMs);
    entry.checkpointTimer.unref?.();
  }
  clearCheckpoint(entry) {
    if (entry.checkpointTimer) clearTimeout(entry.checkpointTimer);
    entry.checkpointTimer = null;
  }
  clearTimer(entry, timer) {
    const handle = timer === "idle" ? entry.idleTimer : entry.cancelTimer;
    if (handle) clearTimeout(handle);
    if (timer === "idle") entry.idleTimer = null;
    else entry.cancelTimer = null;
  }
}
const log$f = logger.domain("backend-manager");
class BackendManager {
  adapters = /* @__PURE__ */ new Map();
  plugins = /* @__PURE__ */ new Map();
  currentBackendId = "codex";
  turnCoordinator;
  /**
   * claude 内部 sessionId（startSession 生成的占位 UUID）→ claude 真实 session_id 的映射。
   * 由 onRealSessionId 回调写入，refreshClaudeSessionTitle 用它把 args.sessionId
   * 翻译成真实 id 后再查 db（db 里的 backend_thread_id 已被 onRealSessionId 回写）。
   */
  claudeSessionIdMap = /* @__PURE__ */ new Map();
  constructor(plugins, options = {}) {
    this.turnCoordinator = options.turnCoordinator ?? new PerTurnCoordinator({
      ...options.turnCoordinatorOptions,
      onError: (error) => log$f.error("turn coordinator error:", error)
    });
    registerMainBackendPlugins();
    const context = {
      onBackendThreadIdResolved: (backendId, internalId, realId) => {
        if (backendId === "claude") this.claudeSessionIdMap.set(internalId, realId);
        if (internalId === realId) return;
        try {
          ctx.db.updateSessionBackendThreadId(backendId, internalId, realId);
          log$f.info("persisted backend real session id", backendId, internalId, "→", realId);
        } catch (error) {
          log$f.warn("failed to persist backend real session id:", error);
        }
      }
    };
    for (const plugin of plugins ?? getBackendPlugins()) {
      const adapter = plugin.createAdapter(context);
      if (adapter.id !== plugin.manifest.id) {
        throw new Error(
          `backend plugin "${plugin.manifest.id}" created adapter with id "${adapter.id}"`
        );
      }
      const undeclaredBlocks = adapter.capabilities.chat.blockTypes.filter(
        (type) => !plugin.manifest.blockTypes.includes(type)
      );
      if (undeclaredBlocks.length > 0) {
        throw new Error(
          `backend plugin "${plugin.manifest.id}" adapter emits undeclared blocks: ${undeclaredBlocks.join(", ")}`
        );
      }
      this.plugins.set(plugin.manifest.id, plugin);
      this.adapters.set(plugin.manifest.id, adapter);
    }
    if (!this.adapters.has(this.currentBackendId)) {
      this.currentBackendId = this.adapters.keys().next().value ?? "codex";
    }
  }
  /**
   * 应用 settings.json 中的后端相关配置。
   * 必须在 settingsStore.load() 之后调用：
   * - 把 backendPaths.{codex,claude} 注入到对应 adapter（用作 binaryPath）
   * - 把 defaultBackend 设为当前后端（不调 initialize——lazy 等真正用时再握手，
   *   避免启动时强制拉起一个用户没在用的后端进程）
   *
   * 注意：只在当前后端与 settings 不一致时切换——用户在本次会话里手动切过的话，
   * 这里不应该覆盖（但 settings 是启动时加载的，所以正常顺序下不会有冲突）。
   */
  applySettings(settings) {
    for (const [id, plugin] of this.plugins) {
      const adapter = this.adapters.get(id);
      if (adapter) plugin.applySettings?.(adapter, settings);
    }
    if (settings.defaultBackend !== this.currentBackendId) {
      const adapter = this.adapters.get(settings.defaultBackend);
      if (adapter) {
        this.currentBackendId = settings.defaultBackend;
        log$f.info("applied defaultBackend from settings:", settings.defaultBackend);
      } else {
        log$f.warn("defaultBackend in settings is unknown:", settings.defaultBackend);
      }
    }
  }
  /** 当前后端 */
  getCurrent() {
    const adapter = this.adapters.get(this.currentBackendId);
    if (!adapter) {
      throw new BackendError("not-initialized", `no adapter for ${this.currentBackendId}`);
    }
    return adapter;
  }
  getCurrentId() {
    return this.currentBackendId;
  }
  /** 切换当前后端 */
  async switchBackend(id) {
    if (id === this.currentBackendId) return;
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new BackendError("not-initialized", `unknown backend: ${id}`);
    }
    const oldAdapter = this.adapters.get(this.currentBackendId);
    oldAdapter?.invalidateModelsCache?.();
    await adapter.initialize();
    this.currentBackendId = id;
    log$f.info("switched backend to", id);
    ctx.broadcast("backend:switched", { id });
    const status = await this.getStatus(id);
    ctx.broadcast("backend:statusChanged", { status });
  }
  /** 列出所有后端的 status */
  async listStatuses() {
    return Promise.all(
      Array.from(this.adapters.keys()).map(async (id) => {
        const adapter = this.adapters.get(id);
        const manifest = this.plugins.get(id)?.manifest;
        const health = await adapter.healthCheck();
        return {
          id,
          ...manifest ? { displayName: manifest.displayName, pluginVersion: manifest.version } : {},
          available: health.ok,
          version: health.version ?? null,
          error: health.error ?? null,
          capabilities: adapter.getCapabilities()
        };
      })
    );
  }
  /** 单个后端的 status */
  async getStatus(id) {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      return {
        id,
        available: false,
        version: null,
        error: "not-initialized",
        capabilities: {
          supportsInterrupt: false,
          supportsApproval: false,
          supportsSteer: false,
          supportsThreadFork: false,
          supportsModelSelection: false,
          supportsEffort: false,
          supportsPermissionMode: false,
          supportedPermissionModes: [],
          supportedEfforts: [],
          supportsHotSwap: false,
          chat: {
            subAgents: false,
            compact: false,
            planMode: false,
            webTools: false,
            blockTypes: ["text", "reasoning", "tool_call", "context"]
          }
        }
      };
    }
    const health = await adapter.healthCheck();
    const manifest = this.plugins.get(id)?.manifest;
    return {
      id,
      ...manifest ? { displayName: manifest.displayName, pluginVersion: manifest.version } : {},
      available: health.ok,
      version: health.version ?? null,
      error: health.error ?? null,
      capabilities: adapter.getCapabilities()
    };
  }
  /** 列出当前后端的模型 */
  async listModels() {
    return this.getCurrent().listModels();
  }
  /**
   * 列出指定 backend 的模型（不切换当前 backend）。
   * 直接取 adapters 里的实例，不走 getCurrent()——用于设置页同时拉两个 backend 的模型列表。
   * 注意：codex 首次调用会触发 initialize（spawn app-server）。
   */
  async listModelsForBackend(id) {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new BackendError("not-initialized", `unknown backend: ${id}`);
    }
    return adapter.listModels();
  }
  /**
   * 强制刷新当前后端的模型列表——先清缓存再重新拉。
   * UI 上的"刷新模型"按钮调它。场景：用户在外面 codex login 换了账户，
   * 想立即看到新账户能用的模型，不想等下次切 backend。
   */
  async refreshModels() {
    const adapter = this.getCurrent();
    adapter.invalidateModelsCache?.();
    return adapter.listModels();
  }
  /** 预热指定 backend，不依赖可能已切换的 currentBackendId。 */
  async warmupBackend(id, args) {
    const adapter = this.adapters.get(id);
    if (!adapter?.warmup) {
      log$f.debug("warmup ignored: backend does not support it", id);
      return;
    }
    log$f.info("warmup requested", id, {
      cwd: args.cwd,
      model: args.model ?? "default",
      effort: args.effort ?? "default"
    });
    await adapter.warmup(args);
  }
  /** 启动会话 */
  async startSession(args) {
    return this.getCurrent().startSession(args);
  }
  /**
   * 启动 turn —— 异步驱动 AsyncIterable，把事件经 IPC 推送。
   * 立即返回 turnId（App 内部生成），不等 turn 完成。
   *
   * envelope 带 sessionId——多 turn 并发时 renderer 用它把事件路由到对应 session 状态。
   */
  async startTurn(args) {
    const { clientTurnId, ...backendArgs } = args;
    const turnId = clientTurnId ?? randomUUID();
    const adapter = this.getCurrent();
    const backendId = this.currentBackendId;
    const routeSessionId = args.clientSessionId ?? args.sessionId;
    this.turnCoordinator.enqueue({
      id: turnId,
      sessionId: routeSessionId,
      backend: backendId,
      // CodexAdapter 当前由一个 app-server 进程承载，内部只有一个活动事件 sink。
      // 不同 CatMax session 若并发启动会互相覆盖 sink，导致实时消息串流；
      // 共用 backend lane 串行执行，同时 envelope 仍按 routeSessionId 分发。
      ...backendId === "codex" ? { laneKey: "backend:codex" } : {},
      run: async (sink) => {
        for await (const event of adapter.startTurn(backendArgs)) {
          sink.publish(event);
        }
      },
      interrupt: async (backendTurnId) => {
        await adapter.interrupt(backendTurnId);
      },
      onEvent: (event) => {
        ctx.broadcast("backend:turnEvent", { turnId, sessionId: routeSessionId, event });
      },
      onSettled: (record) => {
        if (record.startedAt !== null) {
          ctx.db.bumpSessionTurn(
            routeSessionId,
            record.completedAt ?? Date.now(),
            backendArgs.model,
            backendArgs.effort,
            backendArgs.permissionMode
          );
        }
        if (backendId === "claude" && record.startedAt !== null) {
          void this.refreshClaudeSessionTitle(backendArgs.sessionId, backendArgs.cwd).catch(
            (e) => log$f.warn("refreshClaudeSessionTitle failed:", e)
          );
        }
      }
    });
    return { turnId };
  }
  /**
   * turn 完成后从 jsonl 读 aiTitle，回写 db 并广播 sessionTitleChanged 事件
   * 让 renderer 刷新侧边栏。
   *
   * args.sessionId 在 claude 场景下是 startSession 时的占位 UUID。adapter 内部
   * sessionIdMap 把它映射到了真实 session_id；onRealSessionId 回调时 db 的
   * backend_thread_id 已经被回写成真实 id。所以查 db 时要用真实 id。
   */
  async refreshClaudeSessionTitle(backendThreadId, cwd) {
    const realThreadId = this.claudeSessionIdMap.get(backendThreadId) ?? backendThreadId;
    const session2 = ctx.db.findSessionByBackendThreadId("claude", realThreadId);
    if (!session2) {
      log$f.warn("refreshClaudeSessionTitle: session not found for", realThreadId);
      return;
    }
    const workspace = ctx.db.findWorkspaceById(session2.workspaceId);
    const realCwd = cwd ?? workspace?.path;
    const claudeAdapter = this.adapters.get("claude");
    if (!claudeAdapter) return;
    try {
      const { aiTitle } = await claudeAdapter.getHistory(realThreadId, realCwd);
      if (aiTitle && aiTitle !== session2.title) {
        ctx.db.updateSessionTitle(session2.id, aiTitle);
        log$f.info("title refreshed after turn", session2.id, aiTitle);
        ctx.broadcast("session:titleChanged", { sessionId: session2.id, title: aiTitle });
      }
    } catch (e) {
      log$f.warn("refreshClaudeSessionTitle: getHistory failed:", e);
    }
  }
  /** 中断 turn */
  async interruptTurn(turnId) {
    if (await this.turnCoordinator.interrupt(turnId)) return;
    await this.getCurrent().interrupt(turnId);
  }
  /** 响应 approval */
  async respondApproval(decision) {
    const backendId = this.turnCoordinator.findBackendByRequestId(decision.requestId);
    const adapter = backendId ? this.adapters.get(backendId) : this.getCurrent();
    if (!adapter) return;
    await adapter.respondApproval(decision);
  }
  /** 响应 agent 的问题（ask_user 工具） */
  async respondQuestion(args) {
    const backendId = this.turnCoordinator.findBackendByRequestId(args.requestId) ?? this.turnCoordinator.findBackend(args.turnId);
    const adapter = backendId ? this.adapters.get(backendId) : this.getCurrent();
    if (!adapter?.respondQuestion) return;
    await adapter.respondQuestion({
      ...args,
      turnId: this.turnCoordinator.getBackendTurnId(args.turnId) ?? args.turnId
    });
  }
  /** 运行中热切换 turn 配置（model/effort/permissionMode） */
  async updateTurnConfig(turnId, config) {
    const backendId = this.turnCoordinator.findBackend(turnId);
    if (backendId) {
      const adapter2 = this.adapters.get(backendId);
      if (!adapter2?.updateTurnConfig) return;
      this.turnCoordinator.dispatchWhenBound(
        turnId,
        (backendTurnId) => adapter2.updateTurnConfig(backendTurnId, config)
      );
      return;
    }
    const adapter = this.getCurrent();
    if (!adapter.updateTurnConfig) {
      return;
    }
    await adapter.updateTurnConfig(turnId, config);
  }
  /** 向运行中的 turn 追加用户指令；按协调器记录路由到启动它的 backend。 */
  async steerTurn(turnId, prompt) {
    const backendId = this.turnCoordinator.findBackend(turnId);
    if (backendId) {
      const adapter2 = this.adapters.get(backendId);
      if (!adapter2?.steer) return;
      this.turnCoordinator.dispatchWhenBound(
        turnId,
        (backendTurnId) => adapter2.steer(backendTurnId, prompt)
      );
      return;
    }
    const adapter = this.getCurrent();
    if (adapter.steer) await adapter.steer(turnId, prompt);
  }
  listTurnRuns(sessionId) {
    return this.turnCoordinator.list(sessionId);
  }
  /** App 启动、数据库 migrate 后调用。 */
  recoverInterruptedTurns() {
    const recovered = this.turnCoordinator.recoverInterrupted();
    if (recovered.length > 0) {
      log$f.warn("recovered stale turn runs as interrupted:", recovered.length);
    }
    return recovered;
  }
  /**
   * 读会话历史（按 session.backend 选 adapter，不是当前 backend）。
   * 用于 UI 点击侧边栏会话时显示完整历史，只读、不影响后端状态。
   *
   * cwd 必须传——claude adapter 用它作 spawn cwd（历史文件按 cwd 分目录存）。
   * 返回值里的 aiTitle 是后端给的会话标题（claude jsonl 里的 aiTitle 字段）。
   */
  async getHistory(backend, backendThreadId, cwd) {
    const adapter = this.adapters.get(backend);
    if (!adapter) {
      throw new BackendError("not-initialized", `unknown backend: ${backend}`);
    }
    return adapter.getHistory(backendThreadId, cwd);
  }
  /** 列出后端会话（透传给 adapter） */
  async listSessions(cwd) {
    return this.getCurrent().listSessions(cwd);
  }
  /**
   * 物理删除后端侧会话数据（claude jsonl / codex rollout 文件）。
   *
   * 按 backendId 路由到对应 adapter 的 deleteSession。
   * adapter 没实现 / 报错都不抛——上层 removeSession 会同时写 DB tombstone 兜底，
   * 即便这里删不掉文件，reconcile/扫描导入也不会让会话复活。
   */
  async deleteSession(backendId, backendThreadId, cwd) {
    const adapter = this.adapters.get(backendId);
    if (!adapter?.deleteSession) return;
    try {
      await adapter.deleteSession(backendThreadId, cwd);
    } catch (e) {
      log$f.warn("backend.deleteSession failed", backendId, backendThreadId, e);
    }
  }
  /**
   * 全盘扫描所有 backend 的会话（用于「扫描导入」功能）。
   *
   * 与 `listSessions` 的差异：
   * - 不只查当前 backend，遍历所有 adapter（codex + claude）
   * - 不传 cwd——codex thread/list 返回全部；claude 扫所有 ~/.claude/projects/*
   * - 单 backend 失败容错——记到 errors 数组，不影响其他 backend 的结果
   *
   * 注意 codex 调 listSessions 会触发 ensureInitialized——如果 codex 进程没在线
   * 会卡 30s 超时，所以这里用 Promise.allSettled 不阻塞其他 backend。
   */
  async listAllSessionsAcrossBackends() {
    const backendIds = Array.from(this.adapters.keys());
    const settled = await Promise.allSettled(
      backendIds.map(async (id) => ({
        backend: id,
        sessions: await this.adapters.get(id).listSessions()
      }))
    );
    const byBackend = {};
    const errors = [];
    for (const result of settled) {
      if (result.status === "fulfilled") {
        byBackend[result.value.backend] = result.value.sessions;
      } else {
        const failedIdx = settled.indexOf(result);
        const backend = backendIds[failedIdx] ?? "codex";
        byBackend[backend] = [];
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors.push({ backend, error: message });
        log$f.warn(`listSessions failed for ${backend}:`, message);
      }
    }
    return { byBackend, errors };
  }
  /** resume session（透传） */
  async resumeSession(backendThreadId) {
    return this.getCurrent().resumeSession(backendThreadId);
  }
  /** dispose 所有 adapter（app 退出时调） */
  async dispose() {
    await this.turnCoordinator.dispose();
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.dispose();
      } catch (e) {
        log$f.error("dispose error:", e);
      }
    }
  }
}
const schemaSql = `-- catmax-app SQLite schema
-- Plan 1 仅创建 workspaces 和 app_state；其他表在后续 plan 添加

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id              TEXT PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  preferred_editor TEXT,
  last_opened_at  INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_workspaces_last_opened ON workspaces(last_opened_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  backend           TEXT NOT NULL,
  backend_thread_id TEXT NOT NULL,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title             TEXT,
  model             TEXT,
  effort            TEXT,
  permission_mode   TEXT,
  turn_count        INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  last_active_at    INTEGER NOT NULL,
  UNIQUE(backend, backend_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_backend ON sessions(workspace_id, backend);

-- 用户删除过的 (backend, backendThreadId) 记录——tombstone。
-- removeSession 时写入；reconcile/扫描导入查询跳过，防止磁盘文件还在导致"复活"。
-- 物理删除（删 claude jsonl / codex rollout 文件）失败时也兜底。
CREATE TABLE IF NOT EXISTS deleted_sessions (
  backend           TEXT NOT NULL,
  backend_thread_id TEXT NOT NULL,
  deleted_at        INTEGER NOT NULL,
  PRIMARY KEY (backend, backend_thread_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id         TEXT NOT NULL,
  role            TEXT NOT NULL,
  text_preview    TEXT NOT NULL,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

-- per-turn 后台任务协调器的可恢复快照。
-- 本地 Agent 子进程不能跨 App 重启重连；启动恢复时把非终态记录推进 interrupted，
-- 但保留 background_tasks_json 供 UI/诊断读取。
CREATE TABLE IF NOT EXISTS turn_runs (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  backend               TEXT NOT NULL,
  backend_turn_id       TEXT,
  status                TEXT NOT NULL,
  background_tasks_json TEXT NOT NULL DEFAULT '[]',
  created_at            INTEGER NOT NULL,
  started_at            INTEGER,
  last_event_at         INTEGER,
  completed_at          INTEGER,
  error                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_turn_runs_session
  ON turn_runs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_turn_runs_status
  ON turn_runs(status, last_event_at);
`;
const log$e = logger.domain("database");
function rowToRecord(row) {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    preferredEditor: row.preferred_editor,
    lastOpenedAt: row.last_opened_at,
    createdAt: row.created_at
  };
}
class DatabaseService {
  db;
  constructor(dbPath) {
    const path = dbPath ?? this.defaultPath();
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    log$e.info("opened", path);
  }
  defaultPath() {
    try {
      return join(app.getPath("userData"), "catmax.db");
    } catch {
      return join(process.cwd(), "catmax.db");
    }
  }
  migrate() {
    this.db.exec(schemaSql);
    log$e.info("migrated");
  }
  // ===== Workspace =====
  listWorkspaces() {
    const rows = this.db.prepare("SELECT * FROM workspaces ORDER BY last_opened_at DESC").all();
    return rows.map(rowToRecord);
  }
  findWorkspaceByPath(path) {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE path = ?").get(path);
    return row ? rowToRecord(row) : null;
  }
  findWorkspaceById(id) {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
    return row ? rowToRecord(row) : null;
  }
  insertWorkspace(record) {
    this.db.prepare(
      `INSERT INTO workspaces (id, path, name, preferred_editor, last_opened_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.path,
      record.name,
      record.preferredEditor,
      record.lastOpenedAt,
      record.createdAt
    );
    return record;
  }
  updateWorkspaceName(id, name) {
    this.db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(name, id);
  }
  updateWorkspaceEditor(id, editor) {
    this.db.prepare("UPDATE workspaces SET preferred_editor = ? WHERE id = ?").run(editor, id);
  }
  touchWorkspace(id, timestamp) {
    this.db.prepare("UPDATE workspaces SET last_opened_at = ? WHERE id = ?").run(timestamp, id);
  }
  deleteWorkspace(id) {
    this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  }
  // ===== app_state =====
  getState(key) {
    const row = this.db.prepare("SELECT value FROM app_state WHERE key = ?").get(key);
    return row?.value ?? null;
  }
  setState(key, value) {
    this.db.prepare(
      `INSERT INTO app_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }
  deleteState(key) {
    this.db.prepare("DELETE FROM app_state WHERE key = ?").run(key);
  }
  // ===== Session =====
  /**
   * 列出工作区的会话。
   *
   * backend 可选——传了则只返回该 backend 的会话（走 idx_sessions_backend 索引），
   * 不传则返回所有 backend 的会话（走 idx_sessions_workspace 索引，用于 reconcile /
   * scanImportable 等需要全量对账的场景）。
   */
  listSessions(workspaceId, backend) {
    if (backend) {
      const rows2 = this.db.prepare(
        "SELECT * FROM sessions WHERE workspace_id = ? AND backend = ? ORDER BY last_active_at DESC"
      ).all(workspaceId, backend);
      return rows2.map(rowToSessionRecord);
    }
    const rows = this.db.prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY last_active_at DESC").all(workspaceId);
    return rows.map(rowToSessionRecord);
  }
  findSessionById(id) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? rowToSessionRecord(row) : null;
  }
  findSessionByBackendThreadId(backend, backendThreadId) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE backend = ? AND backend_thread_id = ?").get(backend, backendThreadId);
    return row ? rowToSessionRecord(row) : null;
  }
  insertSession(record) {
    this.db.prepare(
      `INSERT INTO sessions (id, backend, backend_thread_id, workspace_id, title, model, effort, permission_mode, turn_count, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.backend,
      record.backendThreadId,
      record.workspaceId,
      record.title,
      record.model,
      record.effort,
      record.permissionMode,
      record.turnCount,
      record.createdAt,
      record.lastActiveAt
    );
    return record;
  }
  updateSessionTitle(id, title) {
    this.db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, id);
  }
  /**
   * 更新 session 的运行时配置（model / effort / permission_mode）。
   *
   * 与 bumpSessionTurn 的区别：
   *   - bumpSessionTurn 用 COALESCE（仅非 null 才覆盖），用于"turn 结束补全字段"。
   *   - updateSessionConfig 直接覆盖，用户在 Composer 里改了配置后立即写回。
   *
   * backend 不在这里写——session.backend 是会话固有属性（创建时定），
   * 切 backend 走全局 currentBackend 切换 + 新建会话时再用。
   *
   * 全部参数可选——只更新传入的字段（用 COALESCE 跳过 undefined）。
   */
  updateSessionConfig(id, config) {
    this.db.prepare(
      `UPDATE sessions
         SET model = COALESCE(?, model),
             effort = COALESCE(?, effort),
             permission_mode = COALESCE(?, permission_mode)
         WHERE id = ?`
    ).run(config.model ?? null, config.effort ?? null, config.permissionMode ?? null, id);
  }
  /**
   * 更新 session 的 backend_thread_id（claude 用：拿到真实 session_id 后回写）。
   * byBackendThreadId 是当前的占位 id，用 (backend, backend_thread_id) 唯一约束定位行。
   */
  updateSessionBackendThreadId(backend, oldBackendThreadId, newBackendThreadId) {
    this.db.prepare(
      `UPDATE sessions SET backend_thread_id = ? WHERE backend = ? AND backend_thread_id = ?`
    ).run(newBackendThreadId, backend, oldBackendThreadId);
  }
  bumpSessionTurn(id, lastActiveAt, model, effort, permissionMode) {
    this.db.prepare(
      `UPDATE sessions
         SET turn_count = turn_count + 1,
             last_active_at = ?,
             model = COALESCE(?, model),
             effort = COALESCE(?, effort),
             permission_mode = COALESCE(?, permission_mode)
         WHERE id = ?`
    ).run(lastActiveAt, model ?? null, effort ?? null, permissionMode ?? null, id);
  }
  deleteSession(id) {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }
  /** 标记 stale（后端已删除但 App 还有索引）—— MVP 不真删，留着让用户决定 */
  markSessionStale(_id) {
  }
  /**
   * 记录 tombstone——removeSession 时调用。
   * 即便物理删除后端文件失败（权限/路径错误），写入 tombstone 也能让
   * reconcileSessions / importSessions 跳过这条，防止会话"复活"。
   */
  insertDeletedSession(backend, backendThreadId) {
    this.db.prepare(
      `INSERT OR REPLACE INTO deleted_sessions (backend, backend_thread_id, deleted_at) VALUES (?, ?, ?)`
    ).run(backend, backendThreadId, Date.now());
  }
  /** 查 (backend, backendThreadId) 是否被用户删除过——reconcile/import 用 */
  isSessionDeleted(backend, backendThreadId) {
    const row = this.db.prepare("SELECT 1 FROM deleted_sessions WHERE backend = ? AND backend_thread_id = ?").get(backend, backendThreadId);
    return row !== void 0;
  }
  // ===== Message =====
  listMessages(sessionId) {
    const rows = this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at").all(sessionId);
    return rows.map(rowToMessagePreview);
  }
  insertMessage(record) {
    this.db.prepare(
      `INSERT INTO messages (id, session_id, turn_id, role, text_preview, tool_call_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.sessionId,
      record.turnId,
      record.role,
      record.textPreview,
      record.toolCallCount,
      record.createdAt
    );
    return record;
  }
  // ===== Turn Run =====
  upsertTurnRun(record) {
    this.db.prepare(
      `INSERT INTO turn_runs (
           id, session_id, backend, backend_turn_id, status, background_tasks_json,
           created_at, started_at, last_event_at, completed_at, error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           backend_turn_id = excluded.backend_turn_id,
           status = excluded.status,
           background_tasks_json = excluded.background_tasks_json,
           started_at = excluded.started_at,
           last_event_at = excluded.last_event_at,
           completed_at = excluded.completed_at,
           error = excluded.error`
    ).run(
      record.id,
      record.sessionId,
      record.backend,
      record.backendTurnId,
      record.status,
      JSON.stringify(record.backgroundTasks),
      record.createdAt,
      record.startedAt,
      record.lastEventAt,
      record.completedAt,
      record.error
    );
  }
  listTurnRuns(sessionId) {
    const rows = sessionId ? this.db.prepare("SELECT * FROM turn_runs WHERE session_id = ? ORDER BY created_at DESC").all(sessionId) : this.db.prepare("SELECT * FROM turn_runs ORDER BY created_at DESC").all();
    return rows.map(rowToTurnRunRecord);
  }
  listRecoverableTurnRuns() {
    const rows = this.db.prepare(
      `SELECT * FROM turn_runs
         WHERE status IN ('queued', 'running', 'cancelling')
         ORDER BY created_at`
    ).all();
    return rows.map(rowToTurnRunRecord);
  }
  deleteTurnRunsCompletedBefore(timestamp) {
    return this.db.prepare(
      `DELETE FROM turn_runs
         WHERE completed_at IS NOT NULL
           AND completed_at < ?
           AND status IN ('completed', 'interrupted', 'error')`
    ).run(timestamp).changes;
  }
  close() {
    this.db.close();
    log$e.info("closed");
  }
}
function rowToSessionRecord(row) {
  return {
    id: row.id,
    backend: row.backend,
    backendThreadId: row.backend_thread_id,
    workspaceId: row.workspace_id,
    title: row.title,
    model: row.model,
    effort: row.effort,
    permissionMode: row.permission_mode,
    turnCount: row.turn_count,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at
  };
}
function rowToMessagePreview(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    role: row.role,
    textPreview: row.text_preview,
    toolCallCount: row.tool_call_count,
    createdAt: row.created_at
  };
}
function rowToTurnRunRecord(row) {
  let backgroundTasks = [];
  try {
    const parsed = JSON.parse(row.background_tasks_json);
    if (Array.isArray(parsed)) {
      backgroundTasks = parsed;
    }
  } catch {
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    backend: row.backend,
    backendTurnId: row.backend_turn_id,
    status: row.status,
    backgroundTasks,
    createdAt: row.created_at,
    startedAt: row.started_at,
    lastEventAt: row.last_event_at,
    completedAt: row.completed_at,
    error: row.error
  };
}
const log$d = logger.domain("pty-manager");
function getDefaultShell() {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "/bin/zsh";
}
class PtyManager {
  instances = /* @__PURE__ */ new Map();
  callbacks;
  constructor(callbacks) {
    this.callbacks = callbacks;
  }
  create(opts = {}) {
    const id = randomUUID();
    const shell2 = opts.shell ?? getDefaultShell();
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    log$d.info("creating terminal", id, shell2);
    const proc = pty.spawn(shell2, [], {
      name: "xterm-color",
      cols,
      rows,
      cwd: opts.cwd ?? process.cwd(),
      env: process.env
    });
    proc.onData((data) => {
      this.callbacks.onData(id, data);
    });
    proc.onExit(({ exitCode }) => {
      log$d.info("terminal exited", id, exitCode);
      this.callbacks.onExit(id, exitCode);
      this.instances.delete(id);
    });
    const instance = { id, pid: proc.pid, proc };
    this.instances.set(id, instance);
    return instance;
  }
  write(id, data) {
    const inst = this.instances.get(id);
    if (!inst) {
      log$d.warn("write: unknown id", id);
      return;
    }
    inst.proc.write(data);
  }
  resize(id, cols, rows) {
    const inst = this.instances.get(id);
    if (!inst) return;
    try {
      inst.proc.resize(cols, rows);
    } catch (e) {
      log$d.warn("resize failed:", e);
    }
  }
  kill(id) {
    const inst = this.instances.get(id);
    if (!inst) return;
    log$d.info("killing terminal", id);
    try {
      inst.proc.kill();
    } catch {
    }
    this.instances.delete(id);
  }
  /** 杀所有（app 退出时） */
  killAll() {
    for (const id of this.instances.keys()) {
      this.kill(id);
    }
  }
  has(id) {
    return this.instances.has(id);
  }
  size() {
    return this.instances.size;
  }
}
const EDITOR_IDS = ["vscode", "cursor", "intellij", "webstorm", "sublime"];
const PUSH = {
  BACKEND_STATUS_CHANGED: "backend:statusChanged",
  /** Backend Install: 下载/解压进度，设置页的安装卡片消费 */
  BACKEND_INSTALL_PROGRESS: "backend:installProgress"
};
const STORAGE_KEYS = {
  /**
   * 最近一次"运行时配置"快照（后端 / 模型 / 权限模式 / 思考强度），
   * 作为新建会话的默认配置。值是 RuntimeConfigSnapshot 的 JSON 字符串。
   */
  LAST_RUNTIME_CONFIG: "last_runtime_config"
};
const DEFAULT_THEME_MODE = "system";
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_EDITOR = "vscode";
const themeModeSchema = enumType(["light", "dark", "system"]);
const fontFamilySchema = objectType({
  sans: stringType().nullable(),
  chat: stringType().nullable(),
  mono: stringType().nullable()
});
const themeSettingsSchema = objectType({
  mode: themeModeSchema.default(DEFAULT_THEME_MODE),
  fontFamily: fontFamilySchema.default({ sans: null, chat: null, mono: null }),
  fontSize: numberType().int().min(11).max(20).default(DEFAULT_FONT_SIZE),
  chatFontSize: numberType().int().min(11).max(20).default(15),
  codeFontSize: numberType().int().min(10).max(18).default(13)
});
const httpProxySchema = objectType({
  enabled: booleanType().default(false),
  url: stringType().nullable().default(null),
  bypass: stringType().nullable().default(null)
});
const backendRuntimeDefaultsSchema = objectType({
  model: stringType().nullable().default(null),
  effort: enumType(["none", "low", "medium", "high", "xhigh", "max"]).nullable().default(null),
  permissionMode: enumType(["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"]).nullable().default(null)
});
const appSettingsSchema = objectType({
  defaultBackend: stringType().regex(/^[a-z0-9][a-z0-9._-]*$/).default("codex"),
  backendPaths: objectType({
    codex: stringType().nullable().default(null),
    claude: stringType().nullable().default(null)
  }).catchall(stringType().nullable()).default({ codex: null, claude: null }),
  /**
   * 默认运行时配置——仅在无 last-used 时兜底（last-used 优先）。
   * 按 backend 分别配（codex / claude 各一组 model/effort/permissionMode）。
   */
  defaultRuntimeConfig: objectType({
    codex: backendRuntimeDefaultsSchema.default({}),
    claude: backendRuntimeDefaultsSchema.default({})
  }).catchall(backendRuntimeDefaultsSchema).default({ codex: {}, claude: {} }),
  defaultEditor: enumType(EDITOR_IDS).default("vscode"),
  theme: themeSettingsSchema.default({}),
  httpProxy: httpProxySchema.default({}),
  language: enumType(["zh-CN", "en-US"]).default("zh-CN"),
  sendOnEnter: booleanType().default(true),
  showReasoningByDefault: booleanType().default(false),
  sidebarWidth: numberType().int().min(200).max(600).default(240),
  rightPanelWidth: numberType().int().min(200).max(800).default(320),
  bottomPanelHeight: numberType().int().min(100).max(600).default(320)
});
const log$c = logger.domain("settings-store");
class SettingsStore {
  filePath;
  cache = null;
  constructor(filePath) {
    this.filePath = filePath ?? this.defaultPath();
  }
  defaultPath() {
    try {
      return join(app.getPath("userData"), "settings.json");
    } catch {
      return join(process.cwd(), "settings.json");
    }
  }
  /** 读取并校验 settings.json。文件不存在返回默认值；损坏时也返回默认值（带警告）。 */
  load() {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      log$c.info("settings file not found, using defaults");
      const defaults = appSettingsSchema.parse({});
      this.cache = defaults;
      this.save(defaults);
      return defaults;
    }
    const raw = readFileSync(this.filePath, "utf-8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      log$c.error("settings.json is not valid JSON, using defaults:", e);
      const defaults = appSettingsSchema.parse({});
      this.cache = defaults;
      return defaults;
    }
    const result = appSettingsSchema.safeParse(parsed);
    if (!result.success) {
      log$c.warn("settings.json failed schema validation, using defaults:", result.error.issues);
      const defaults = appSettingsSchema.parse({});
      this.cache = defaults;
      return defaults;
    }
    this.cache = result.data;
    log$c.info("loaded settings");
    return result.data;
  }
  /** 部分更新 settings，写盘，返回完整 settings。 */
  update(patch) {
    const current = this.load();
    const runtimeDefaults = { ...current.defaultRuntimeConfig };
    for (const [backendId, backendPatch] of Object.entries(patch.defaultRuntimeConfig ?? {})) {
      runtimeDefaults[backendId] = {
        ...current.defaultRuntimeConfig[backendId],
        ...backendPatch
      };
    }
    const merged = {
      ...current,
      ...patch,
      theme: { ...current.theme, ...patch.theme ?? {} },
      httpProxy: { ...current.httpProxy, ...patch.httpProxy ?? {} },
      backendPaths: { ...current.backendPaths, ...patch.backendPaths ?? {} },
      defaultRuntimeConfig: runtimeDefaults
    };
    const validated = appSettingsSchema.parse(merged);
    this.cache = validated;
    this.save(validated);
    log$c.info("updated settings");
    return validated;
  }
  reset() {
    const defaults = appSettingsSchema.parse({});
    this.cache = defaults;
    this.save(defaults);
    log$c.info("reset to defaults");
    return defaults;
  }
  save(settings) {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(settings, null, 2), "utf-8");
  }
}
const log$b = logger.domain("context");
class Context {
  windows = /* @__PURE__ */ new Map();
  db;
  settingsStore;
  backendManager;
  ptyManager;
  constructor() {
    this.db = new DatabaseService();
    this.settingsStore = new SettingsStore();
    this.backendManager = new BackendManager(void 0, {
      turnCoordinatorOptions: {
        repository: new DatabaseTurnRunRepository(this.db)
      }
    });
    this.ptyManager = new PtyManager({
      onData: (id, data) => {
        this.broadcast("pty:data", { id, data });
      },
      onExit: (id, exitCode) => {
        this.broadcast("pty:exit", { id, exitCode });
      }
    });
  }
  registerWindow(id, win) {
    this.windows.set(id, win);
    win.on("closed", () => {
      this.windows.delete(id);
      log$b.info("window closed", id);
    });
  }
  getMainWindow() {
    return this.windows.get("main");
  }
  /** 向所有窗口广播事件（用于推送） */
  broadcast(channel, ...args) {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args);
      }
    }
  }
}
const ctx = new Context();
function handleRendererRequest(channel, handler) {
  if (ipcMain.eventNames().includes(channel)) {
    throw new Error(`IPC handler "${channel}" already registered`);
  }
  const wrapped = (_event, ...args) => handler(...args);
  ipcMain.handle(channel, wrapped);
}
const CODEX_CONFIG_TEMPLATE = `# Codex 配置文件（TOML）。完整字段见官方 config 文档。
# 常用项：
# model = "gpt-5-codex"
# model_reasoning_effort = "medium"
# approval_policy = "on-request"

# 自定义 model provider（走第三方中转时用）：
# [model_providers.custom]
# name = "custom"
# base_url = "https://example.com/v1"
# env_key = "CUSTOM_API_KEY"
`;
const CODEX_AUTH_TEMPLATE = `{
  "OPENAI_API_KEY": ""
}
`;
const CLAUDE_SETTINGS_TEMPLATE = `{
  "env": {},
  "permissions": {
    "allow": [],
    "deny": []
  }
}
`;
const BACKEND_CONFIG_FILES = [
  {
    id: "claude.settings",
    backendId: "claude",
    relativePath: "settings.json",
    label: "settings.json",
    description: "全局设置：env（含 ANTHROPIC_BASE_URL 等）、permissions、hooks、model。",
    format: "json",
    sensitive: false,
    template: CLAUDE_SETTINGS_TEMPLATE,
    docsUrl: "https://docs.claude.com/en/docs/claude-code/settings"
  },
  {
    id: "codex.config",
    backendId: "codex",
    relativePath: "config.toml",
    label: "config.toml",
    description: "全局设置：model、model_provider、approval_policy、sandbox、MCP server。",
    format: "toml",
    sensitive: false,
    template: CODEX_CONFIG_TEMPLATE,
    docsUrl: "https://github.com/openai/codex/blob/main/docs/config.md"
  },
  {
    id: "codex.auth",
    backendId: "codex",
    relativePath: "auth.json",
    label: "auth.json",
    description: "凭证文件：API key / OAuth token。改坏会导致 codex 需要重新登录。",
    format: "json",
    sensitive: true,
    template: CODEX_AUTH_TEMPLATE,
    docsUrl: "https://github.com/openai/codex/blob/main/docs/authentication.md"
  }
];
function getBackendConfigFileDescriptor(id) {
  return BACKEND_CONFIG_FILES.find((d) => d.id === id);
}
const MAX_BACKEND_CONFIG_BYTES = 512 * 1024;
const BACKEND_CONFIG_BACKUP_KEEP = 10;
const log$a = logger.domain("backend-config-files");
const SENSITIVE_FILE_MODE = 384;
const DEFAULT_FILE_MODE = 420;
const CONFIG_DIR_MODE = 448;
function resolveBackendConfigDir(backendId) {
  if (backendId === "codex") {
    const override = process.env.CODEX_HOME?.trim();
    return override ? override : join(homedir(), ".codex");
  }
  if (backendId === "claude") {
    const override = process.env.CLAUDE_CONFIG_DIR?.trim();
    return override ? override : join(homedir(), ".claude");
  }
  return join(homedir(), `.${backendId}`);
}
function resolveBackendConfigPath(descriptor) {
  return join(resolveBackendConfigDir(descriptor.backendId), descriptor.relativePath);
}
function backupRoot() {
  try {
    return join(app.getPath("userData"), "backend-config-backups");
  } catch {
    return join(homedir(), ".catmax", "backend-config-backups");
  }
}
function requireDescriptor(id) {
  const descriptor = getBackendConfigFileDescriptor(id);
  if (!descriptor) {
    throw new Error(`未知的后端配置文件 id: ${id}`);
  }
  return descriptor;
}
function describeConfigFile(descriptor) {
  const path = resolveBackendConfigPath(descriptor);
  let exists = false;
  let size = 0;
  let mtimeMs = null;
  try {
    const stat2 = statSync(path);
    if (stat2.isFile()) {
      exists = true;
      size = stat2.size;
      mtimeMs = stat2.mtimeMs;
    }
  } catch {
  }
  return {
    id: descriptor.id,
    backendId: descriptor.backendId,
    label: descriptor.label,
    description: descriptor.description,
    format: descriptor.format,
    sensitive: descriptor.sensitive,
    docsUrl: descriptor.docsUrl,
    path,
    exists,
    size,
    mtimeMs
  };
}
function listBackendConfigFiles$1() {
  return BACKEND_CONFIG_FILES.map(describeConfigFile);
}
function jsonSyntaxError(content, error) {
  const message = error instanceof Error ? error.message : String(error);
  const lineCol = /line (\d+) column (\d+)/.exec(message);
  if (lineCol) {
    return { ok: false, message, line: Number(lineCol[1]), column: Number(lineCol[2]) };
  }
  const positionMatch = /position (\d+)/.exec(message);
  if (positionMatch) {
    const position = Number(positionMatch[1]);
    const before = content.slice(0, position);
    const line = before.split("\n").length;
    const column = position - before.lastIndexOf("\n");
    return { ok: false, message, line, column };
  }
  return { ok: false, message, line: null, column: null };
}
function validateConfigSyntax(format, content) {
  if (content.trim().length === 0) {
    return format === "toml" ? { ok: true } : { ok: false, message: "内容不能为空（至少要有一个 {}）", line: 1, column: 1 };
  }
  if (format === "toml") {
    try {
      parse(content);
      return { ok: true };
    } catch (e) {
      if (e instanceof TomlError) {
        return { ok: false, message: e.message, line: e.line, column: e.column };
      }
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        line: null,
        column: null
      };
    }
  }
  try {
    const parsed = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, message: "顶层必须是一个 JSON 对象", line: 1, column: 1 };
    }
    return { ok: true };
  } catch (e) {
    return jsonSyntaxError(content, e);
  }
}
function validateBackendConfigContent(id, content) {
  return validateConfigSyntax(requireDescriptor(id).format, content);
}
function readBackendConfigFile$1(id) {
  const descriptor = requireDescriptor(id);
  const info = describeConfigFile(descriptor);
  if (!info.exists) {
    return { ...info, content: descriptor.template, usingTemplate: true };
  }
  if (info.size > MAX_BACKEND_CONFIG_BYTES) {
    throw new Error(
      `${info.path} 超过 ${Math.round(MAX_BACKEND_CONFIG_BYTES / 1024)}KB，请用外部编辑器修改`
    );
  }
  return { ...info, content: readFileSync(info.path, "utf-8"), usingTemplate: false };
}
function backupExisting(descriptor, sourcePath) {
  try {
    const dir = join(backupRoot(), descriptor.id);
    mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE });
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const target = join(dir, `${stamp}-${randomBytes(2).toString("hex")}.bak`);
    copyFileSync(sourcePath, target);
    if (descriptor.sensitive) chmodSync(target, SENSITIVE_FILE_MODE);
    rotateBackups(dir);
    return target;
  } catch (e) {
    log$a.warn(`backup failed for ${descriptor.id}:`, e);
    return null;
  }
}
function rotateBackups(dir) {
  const files = readdirSync(dir).filter((name) => name.endsWith(".bak")).sort();
  const stale = files.slice(0, Math.max(0, files.length - BACKEND_CONFIG_BACKUP_KEEP));
  for (const name of stale) {
    try {
      unlinkSync(join(dir, name));
    } catch {
    }
  }
}
function targetMode(descriptor, path) {
  if (descriptor.sensitive) return SENSITIVE_FILE_MODE;
  try {
    return statSync(path).mode & 511;
  } catch {
    return DEFAULT_FILE_MODE;
  }
}
function atomicWrite(path, content, mode) {
  const tmpPath = join(dirname(path), `.catmax-${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = openSync(tmpPath, "wx", mode);
    try {
      writeSync(fd, content, null, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmpPath, mode);
    renameSync(tmpPath, path);
  } catch (e) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
    }
    throw e;
  }
}
function writeBackendConfigFile$1(args) {
  const descriptor = requireDescriptor(args.id);
  const syntax = validateConfigSyntax(descriptor.format, args.content);
  if (!syntax.ok) {
    return { ok: false, reason: "invalid-syntax", syntax };
  }
  if (Buffer.byteLength(args.content, "utf-8") > MAX_BACKEND_CONFIG_BYTES) {
    return {
      ok: false,
      reason: "io-error",
      message: `内容超过 ${Math.round(MAX_BACKEND_CONFIG_BYTES / 1024)}KB 上限`
    };
  }
  const current = describeConfigFile(descriptor);
  if (!args.force && !sameRevision(current, args.expectedMtimeMs)) {
    return { ok: false, reason: "conflict", info: current };
  }
  try {
    mkdirSync(dirname(current.path), { recursive: true, mode: CONFIG_DIR_MODE });
    const backupPath = current.exists ? backupExisting(descriptor, current.path) : null;
    atomicWrite(current.path, args.content, targetMode(descriptor, current.path));
    log$a.info(`wrote ${descriptor.id} (${current.path})`);
    return { ok: true, info: describeConfigFile(descriptor), backupPath };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log$a.error(`write failed for ${descriptor.id}:`, e);
    return { ok: false, reason: "io-error", message };
  }
}
function sameRevision(current, expectedMtimeMs) {
  if (!current.exists) return expectedMtimeMs === null;
  if (expectedMtimeMs === null) return false;
  return Math.round(current.mtimeMs ?? 0) === Math.round(expectedMtimeMs);
}
const INSTALLABLE_BACKEND_IDS = ["codex"];
function isInstallableBackend(id) {
  return INSTALLABLE_BACKEND_IDS.includes(id);
}
const log$9 = logger.domain("backend-installer");
const CODEX_PACKAGE = "@openai/codex";
const REGISTRIES = ["https://registry.npmjs.org", "https://registry.npmmirror.com"];
const TARGET_TRIPLES = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc"
};
const PROGRESS_THROTTLE_MS = 200;
class CancelledError extends Error {
  constructor() {
    super("installation cancelled");
    this.name = "CancelledError";
  }
}
class InstallError extends Error {
  constructor(message) {
    super(message);
    this.name = "InstallError";
  }
}
const running = /* @__PURE__ */ new Map();
async function installBackend$1(args) {
  const { id, proxyUrl, onProgress } = args;
  if (!isInstallableBackend(id)) {
    return { ok: false, error: `${id} 不支持一键安装` };
  }
  if (running.has(id)) {
    return { ok: false, error: "已有一个安装任务在进行中" };
  }
  const controller = new AbortController();
  running.set(id, controller);
  let version = null;
  const emit = (phase, extra) => {
    onProgress({
      backendId: id,
      phase,
      receivedBytes: extra?.receivedBytes ?? 0,
      totalBytes: extra?.totalBytes ?? null,
      version,
      error: extra?.error ?? null
    });
  };
  try {
    const result = await installCodex({
      proxyUrl,
      signal: controller.signal,
      emit,
      onVersionResolved: (v) => {
        version = v;
      }
    });
    emit("done");
    return { ok: true, binaryPath: result.binaryPath, version: result.version };
  } catch (e) {
    if (e instanceof CancelledError || controller.signal.aborted) {
      emit("cancelled");
      return { ok: false, cancelled: true };
    }
    const message = e instanceof Error ? e.message : String(e);
    log$9.error("install failed:", message);
    emit("error", { error: message });
    return { ok: false, error: message };
  } finally {
    running.delete(id);
  }
}
function cancelBackendInstall$1(id) {
  const controller = running.get(id);
  if (!controller) return;
  log$9.info("cancelling install for", id);
  controller.abort();
}
async function installCodex(args) {
  const { proxyUrl, signal, emit, onVersionResolved } = args;
  const platformKey = `${process.platform}-${process.arch}`;
  const triple = TARGET_TRIPLES[platformKey];
  if (!triple) {
    throw new InstallError(`不支持的平台：${platformKey}`);
  }
  const ses = await createInstallerSession(proxyUrl);
  emit("resolving");
  const release = await resolveCodexRelease(ses, signal, platformKey);
  onVersionResolved(release.displayVersion);
  log$9.info("resolved codex", release.version, "from", release.tarball);
  const rootDir = join(app.getPath("userData"), "backends", "codex");
  const targetDir = join(rootDir, release.version);
  const binaryPath = join(targetDir, "bin", codexBinaryName());
  if (await pathExists(binaryPath)) {
    log$9.info("already installed at", binaryPath);
    emit("finalizing");
    await finalizeBinary(binaryPath);
    return { binaryPath, version: release.displayVersion };
  }
  await mkdir(rootDir, { recursive: true });
  const tmpDir = join(rootDir, `.tmp-${Date.now()}`);
  const tarPath = join(tmpDir, "codex.tgz");
  await mkdir(tmpDir, { recursive: true });
  try {
    emit("downloading", { receivedBytes: 0, totalBytes: null });
    let lastEmit = 0;
    const digest = await downloadToFile({
      url: release.tarball,
      dest: tarPath,
      ses,
      signal,
      onProgress: (received, total) => {
        const now = Date.now();
        if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
        lastEmit = now;
        emit("downloading", { receivedBytes: received, totalBytes: total });
      }
    });
    emit("verifying");
    if (release.integrity) {
      const expected = parseSha512Integrity(release.integrity);
      if (expected && expected !== digest) {
        throw new InstallError("下载文件校验失败（sha512 不匹配），已丢弃。请重试或换个网络环境。");
      }
    } else {
      log$9.warn("registry did not provide dist.integrity; skipping checksum verification");
    }
    emit("extracting");
    const extractDir = join(tmpDir, "out");
    await mkdir(extractDir, { recursive: true });
    await extractTarball({ tarPath, destDir: extractDir, triple, signal });
    const extractedBinary = join(extractDir, "bin", codexBinaryName());
    if (!await pathExists(extractedBinary)) {
      throw new InstallError("解压后没找到 codex 可执行文件，产物结构可能变了");
    }
    emit("finalizing");
    await finalizeBinary(extractedBinary);
    await rm(targetDir, { recursive: true, force: true });
    await rename(extractDir, targetDir);
    const health = checkCliHealth(binaryPath, ["--version"]);
    if (!health.ok) {
      throw new InstallError(`安装完成但无法运行（${health.error}）。可能被系统安全策略拦截。`);
    }
    await pruneOldVersions(rootDir, release.version);
    return { binaryPath, version: release.displayVersion };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {
    });
  }
}
async function resolveCodexRelease(ses, signal, platformKey) {
  let lastError = null;
  for (const registry2 of REGISTRIES) {
    try {
      const latest = await fetchJson(`${registry2}/${CODEX_PACKAGE}/latest`, ses, signal);
      const displayVersion = latest.version;
      if (!displayVersion) throw new InstallError("registry 返回的 latest 没有版本号");
      const alias = latest.optionalDependencies?.[`${CODEX_PACKAGE}-${platformKey}`];
      const version = parseAliasVersion(alias) ?? `${displayVersion}-${platformKey}`;
      const meta = await fetchJson(`${registry2}/${CODEX_PACKAGE}/${version}`, ses, signal);
      const tarball = meta.dist?.tarball;
      if (!tarball) throw new InstallError(`registry 没有 ${version} 的 tarball 地址`);
      return {
        version,
        displayVersion,
        tarball,
        integrity: meta.dist?.integrity ?? null
      };
    } catch (e) {
      if (e instanceof CancelledError || signal.aborted) throw e;
      log$9.warn(`registry ${registry2} failed:`, e instanceof Error ? e.message : e);
      lastError = e;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new InstallError(`无法连接 npm registry 获取 codex 版本信息：${detail}`);
}
function parseAliasVersion(alias) {
  if (!alias) return null;
  const match = alias.match(/^npm:@[^@]+@(.+)$/);
  return match?.[1] ?? null;
}
function parseSha512Integrity(integrity) {
  const entry = integrity.split(/\s+/).find((part) => part.startsWith("sha512-"));
  return entry ? entry.slice("sha512-".length) : null;
}
function codexBinaryName() {
  return process.platform === "win32" ? "codex.exe" : "codex";
}
async function finalizeBinary(binaryPath) {
  if (process.platform === "win32") return;
  await chmod(binaryPath, 493).catch((e) => {
    log$9.warn("chmod failed:", e);
  });
}
async function pruneOldVersions(rootDir, keepVersion) {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === keepVersion) continue;
      if (entry.name.startsWith(".tmp-")) continue;
      await rm(join(rootDir, entry.name), { recursive: true, force: true });
      log$9.info("pruned old version", entry.name);
    }
  } catch (e) {
    log$9.warn("pruneOldVersions failed:", e);
  }
}
async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
async function createInstallerSession(proxyUrl) {
  const ses = session.fromPartition("backend-installer");
  if (proxyUrl) {
    await ses.setProxy({ proxyRules: normalizeProxyUrl(proxyUrl) });
  } else {
    await ses.setProxy({ mode: "system" });
  }
  return ses;
}
function openRequest(url, ses, signal) {
  return new Promise((resolve2, reject) => {
    if (signal.aborted) {
      reject(new CancelledError());
      return;
    }
    const request = net.request({ url, session: ses, redirect: "follow" });
    const onAbort = () => request.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    request.on("response", (response) => {
      const stream = response;
      const status = response.statusCode;
      if (status < 200 || status >= 300) {
        stream.resume();
        reject(new InstallError(`HTTP ${status}：${url}`));
        return;
      }
      resolve2(stream);
    });
    request.on("abort", () => reject(new CancelledError()));
    request.on("error", (err) => reject(err));
    request.end();
  });
}
async function fetchJson(url, ses, signal) {
  const response = await openRequest(url, ses, signal);
  const chunks = [];
  await new Promise((resolve2, reject) => {
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolve2());
    response.on("error", (err) => reject(err));
    response.on("aborted", () => reject(new CancelledError()));
  });
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}
async function downloadToFile(args) {
  const { url, dest, ses, signal, onProgress } = args;
  const response = await openRequest(url, ses, signal);
  const lengthHeader = response.headers["content-length"];
  const rawLength = Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader;
  const total = rawLength ? Number(rawLength) : null;
  const totalBytes = total !== null && Number.isFinite(total) ? total : null;
  const hash = createHash("sha512");
  const out = createWriteStream(dest);
  let received = 0;
  try {
    await new Promise((resolve2, reject) => {
      response.on("data", (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        if (!out.write(chunk)) {
          response.pause();
          out.once("drain", () => response.resume());
        }
        onProgress(received, totalBytes);
      });
      response.on("end", () => out.end(() => resolve2()));
      response.on("error", (err) => reject(err));
      response.on("aborted", () => reject(new CancelledError()));
      out.on("error", (err) => reject(err));
    });
  } finally {
    out.destroy();
  }
  onProgress(received, totalBytes);
  return hash.digest("base64");
}
function extractTarball(args) {
  const { tarPath, destDir, triple, signal } = args;
  return new Promise((resolve2, reject) => {
    const child = spawn(
      "tar",
      ["-xzf", tarPath, "-C", destDir, "--strip-components=3", `package/vendor/${triple}`],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    const onAbort = () => {
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new InstallError("系统里没有 tar 命令，无法解压。请改用手动安装。"));
        return;
      }
      reject(err);
    });
    child.on("close", (code, sig) => {
      if (signal.aborted) {
        reject(new CancelledError());
        return;
      }
      if (code === 0) {
        resolve2();
        return;
      }
      reject(new InstallError(`解压失败（tar exit=${code} signal=${sig}）：${stderr.trim()}`));
    });
  });
}
const log$8 = logger.domain("backend-handler");
const listBackends = async () => {
  return ctx.backendManager.listStatuses();
};
const getCurrentBackend = async () => {
  return { id: ctx.backendManager.getCurrentId() };
};
const switchBackend = async (args) => {
  await ctx.backendManager.switchBackend(args.id);
};
const listModels = async () => {
  return ctx.backendManager.listModels();
};
const listModelsFor = async (args) => {
  return ctx.backendManager.listModelsForBackend(args.id);
};
const refreshModels = async () => {
  return ctx.backendManager.refreshModels();
};
const warmupBackend = async (args) => {
  await ctx.backendManager.warmupBackend(args.id, args.config);
};
const startTurn = async (args) => {
  return ctx.backendManager.startTurn(args);
};
const interruptTurn = async (args) => {
  await ctx.backendManager.interruptTurn(args.turnId);
};
const steerTurn = async (args) => {
  await ctx.backendManager.steerTurn(args.turnId, args.prompt);
};
const listTurnRuns = async (args) => {
  return ctx.backendManager.listTurnRuns(args?.sessionId);
};
const respondApproval = async (args) => {
  await ctx.backendManager.respondApproval(args);
};
const respondQuestion = async (args) => {
  await ctx.backendManager.respondQuestion(args);
};
const updateTurnConfig = async (args) => {
  await ctx.backendManager.updateTurnConfig(args.turnId, args.config);
};
const installBackend = async (args) => {
  const settings = ctx.settingsStore.load();
  const proxyUrl = settings.httpProxy.enabled ? settings.httpProxy.url : null;
  const result = await installBackend$1({
    id: args.id,
    proxyUrl,
    onProgress: (progress) => ctx.broadcast(PUSH.BACKEND_INSTALL_PROGRESS, progress)
  });
  if (result.ok && result.binaryPath) {
    const current = ctx.settingsStore.load();
    const updated = ctx.settingsStore.update({
      backendPaths: { ...current.backendPaths, [args.id]: result.binaryPath }
    });
    try {
      ctx.backendManager.applySettings(updated);
    } catch (e) {
      log$8.warn("applySettings after install failed:", e);
    }
    const status = await ctx.backendManager.getStatus(args.id);
    ctx.broadcast(PUSH.BACKEND_STATUS_CHANGED, { status });
  }
  return result;
};
const cancelBackendInstall = async (args) => {
  cancelBackendInstall$1(args.id);
};
const listBackendConfigFiles = async () => {
  return listBackendConfigFiles$1();
};
const readBackendConfigFile = async (args) => {
  return readBackendConfigFile$1(args.id);
};
const writeBackendConfigFile = async (args) => {
  return writeBackendConfigFile$1(args);
};
const validateBackendConfigFile = async (args) => {
  return validateBackendConfigContent(args.id, args.content);
};
const revealBackendConfigFile = async (args) => {
  const descriptor = getBackendConfigFileDescriptor(args.id);
  if (!descriptor) throw new Error(`未知的后端配置文件 id: ${args.id}`);
  const filePath = resolveBackendConfigPath(descriptor);
  if (existsSync(filePath)) {
    shell.showItemInFolder(filePath);
    return;
  }
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 448 });
  await shell.openPath(dir);
};
function registerBackendHandlers() {
  handleRendererRequest("backend.list", listBackends);
  handleRendererRequest("backend.current", getCurrentBackend);
  handleRendererRequest("backend.switch", switchBackend);
  handleRendererRequest("backend.listModels", listModels);
  handleRendererRequest(
    "backend.listModelsFor",
    listModelsFor
  );
  handleRendererRequest(
    "backend.refreshModels",
    refreshModels
  );
  handleRendererRequest("backend.warmup", warmupBackend);
  handleRendererRequest("backend.startTurn", startTurn);
  handleRendererRequest(
    "backend.interruptTurn",
    interruptTurn
  );
  handleRendererRequest("backend.steerTurn", steerTurn);
  handleRendererRequest(
    "backend.listTurnRuns",
    listTurnRuns
  );
  handleRendererRequest(
    "backend.respondApproval",
    respondApproval
  );
  handleRendererRequest(
    "backend.respondQuestion",
    respondQuestion
  );
  handleRendererRequest(
    "backend.updateTurnConfig",
    updateTurnConfig
  );
  handleRendererRequest("backend.install", installBackend);
  handleRendererRequest(
    "backend.cancelInstall",
    cancelBackendInstall
  );
  handleRendererRequest(
    "backend.listConfigFiles",
    listBackendConfigFiles
  );
  handleRendererRequest(
    "backend.readConfigFile",
    readBackendConfigFile
  );
  handleRendererRequest(
    "backend.writeConfigFile",
    writeBackendConfigFile
  );
  handleRendererRequest(
    "backend.validateConfigFile",
    validateBackendConfigFile
  );
  handleRendererRequest(
    "backend.revealConfigFile",
    revealBackendConfigFile
  );
}
const log$7 = logger.domain("editor-launcher");
const EDITOR_COMMANDS = {
  vscode: ["code"],
  cursor: ["cursor"],
  intellij: ["idea"],
  webstorm: ["webstorm"],
  sublime: ["subl"]
};
const EDITOR_NAMES = {
  vscode: "VS Code",
  cursor: "Cursor",
  intellij: "IntelliJ IDEA",
  webstorm: "WebStorm",
  sublime: "Sublime Text"
};
async function launchInEditor(editor, opts) {
  const absPath = opts.absolutePath ?? join(opts.workspacePath, opts.relativePath);
  if (!existsSync(absPath)) {
    return { launched: false, editor, error: `file does not exist: ${absPath}` };
  }
  const commands = EDITOR_COMMANDS[editor];
  if (!commands) {
    return { launched: false, editor, error: `unknown editor: ${editor}` };
  }
  const positionSuffix = opts.line !== void 0 ? opts.column !== void 0 ? `:${opts.line}:${opts.column}` : `:${opts.line}` : "";
  const fileArg = `${absPath}${positionSuffix}`;
  let args;
  switch (editor) {
    case "intellij":
    case "webstorm":
      args = opts.line !== void 0 ? [`${opts.line}`, absPath] : [absPath];
      break;
    case "vscode":
    case "cursor":
    case "sublime":
    default:
      args = [fileArg];
      break;
  }
  return new Promise((resolve2) => {
    try {
      const child = spawn(commands[0], args, {
        detached: true,
        stdio: "ignore",
        cwd: opts.workspacePath
      });
      child.on("error", (err) => {
        const message = err.code === "ENOENT" ? `${EDITOR_NAMES[editor]} CLI 命令 '${commands[0]}' 未找到。请确认已安装且在 PATH 中。` : `启动失败: ${err.message}`;
        log$7.warn("editor launch error:", message);
        resolve2({ launched: false, editor, error: message });
      });
      child.on("spawn", () => {
        log$7.info("launched", editor, absPath);
        resolve2({ launched: true, editor });
        child.unref();
      });
    } catch (e) {
      resolve2({ launched: false, editor, error: String(e) });
    }
  });
}
const log$6 = logger.domain("file-tree");
const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  "dist",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  ".DS_Store",
  "Thumbs.db",
  "*.log"
];
const MAX_DIRECTORY_ENTRIES = 2e3;
const MAX_SEARCH_VISITS = 2e4;
const MAX_SEARCH_RESULTS = 200;
const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;
const MAX_MEDIA_PREVIEW_BYTES = 12 * 1024 * 1024;
const IMAGE_MIME = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp"
};
const AUDIO_MIME = {
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  wav: "audio/wav"
};
const VIDEO_MIME = {
  m4v: "video/mp4",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  ogv: "video/ogg",
  webm: "video/webm"
};
const DOCUMENT_MIME = {
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odp: "application/vnd.oasis.opendocument.presentation",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odt: "application/vnd.oasis.opendocument.text",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};
const ARCHIVE_MIME = {
  "7z": "application/x-7z-compressed",
  bz2: "application/x-bzip2",
  gz: "application/gzip",
  rar: "application/vnd.rar",
  tar: "application/x-tar",
  tgz: "application/gzip",
  zip: "application/zip"
};
const TABLE_EXTENSIONS = /* @__PURE__ */ new Set(["csv", "psv", "tsv"]);
const MARKDOWN_EXTENSIONS = /* @__PURE__ */ new Set(["md", "mdx", "markdown"]);
async function resolveWorkspaceEntry(workspacePath, inputPath) {
  const root = await promises.realpath(workspacePath);
  const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath || ".");
  assertWithinRoot(root, candidate);
  const realTarget = await promises.realpath(candidate);
  assertWithinRoot(root, realTarget);
  return {
    absolutePath: realTarget,
    relativePath: toPosixPath(relative(root, candidate))
  };
}
async function readDirectory(workspacePath, relativePath = "", respectGitignore = true) {
  const { absolutePath, relativePath: safeRelativePath } = await resolveWorkspaceEntry(
    workspacePath,
    relativePath
  );
  const stat2 = await promises.stat(absolutePath);
  if (!stat2.isDirectory()) throw new Error(`not a directory: ${relativePath}`);
  const ig = respectGitignore ? await loadGitignore(workspacePath) : ignore().add(DEFAULT_IGNORE);
  const entries = await promises.readdir(absolutePath, { withFileTypes: true });
  const visible = entries.filter((entry) => !DEFAULT_IGNORE.includes(entry.name)).slice(0, MAX_DIRECTORY_ENTRIES);
  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    log$6.warn("hit MAX_DIRECTORY_ENTRIES, truncating:", absolutePath);
  }
  const result = await Promise.all(
    visible.map(
      (entry) => toDirectoryEntry(absolutePath, safeRelativePath, entry, ig).catch((error) => {
        log$6.debug("skip unreadable directory entry:", entry.name, error);
        return null;
      })
    )
  );
  return result.filter((entry) => entry !== null).sort(compareDirectoryEntries);
}
async function searchWorkspace(workspacePath, query2, requestedLimit = MAX_SEARCH_RESULTS) {
  const normalizedQuery = query2.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];
  const root = await promises.realpath(workspacePath);
  const ig = await loadGitignore(root);
  const limit = Math.max(1, Math.min(requestedLimit, MAX_SEARCH_RESULTS));
  const queue = [""];
  const result = [];
  let visited = 0;
  while (queue.length > 0 && result.length < limit && visited < MAX_SEARCH_VISITS) {
    const currentRelative = queue.shift();
    const currentAbsolute = resolve(root, currentRelative);
    let entries;
    try {
      entries = await promises.readdir(currentAbsolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited++ >= MAX_SEARCH_VISITS || result.length >= limit) break;
      if (DEFAULT_IGNORE.includes(entry.name) || entry.isSymbolicLink()) continue;
      const entryRelative = toPosixPath(
        currentRelative ? `${currentRelative}/${entry.name}` : entry.name
      );
      const isDirectory = entry.isDirectory();
      if (ig.ignores(isDirectory ? `${entryRelative}/` : entryRelative)) continue;
      if (isDirectory) queue.push(entryRelative);
      if (!entryRelative.toLocaleLowerCase().includes(normalizedQuery)) continue;
      const stat2 = await promises.stat(resolve(root, entryRelative));
      result.push({
        name: entry.name,
        relativePath: entryRelative,
        isDirectory,
        isSymlink: false,
        size: stat2.size,
        modifiedAt: stat2.mtimeMs
      });
    }
  }
  return result.sort(compareSearchResults(normalizedQuery));
}
async function readFilePreview(workspacePath, relativePath, absolutePath) {
  const resolved = absolutePath ? { absolutePath, relativePath } : await resolveWorkspaceEntry(workspacePath, relativePath);
  const stat2 = await promises.stat(resolved.absolutePath);
  if (!stat2.isFile()) throw new Error(`not a file: ${relativePath}`);
  const extension = extname(resolved.absolutePath).slice(1).toLowerCase();
  const media = mediaType(extension);
  if (media) {
    const data = stat2.size <= MAX_MEDIA_PREVIEW_BYTES ? await promises.readFile(resolved.absolutePath) : null;
    return previewResult(resolved, stat2, {
      kind: media.kind,
      mimeType: media.mimeType,
      isBinary: true,
      dataUrl: data ? `data:${media.mimeType};base64,${data.toString("base64")}` : null,
      truncated: data === null
    });
  }
  if (extension === "pdf") {
    const data = stat2.size <= MAX_MEDIA_PREVIEW_BYTES ? await promises.readFile(resolved.absolutePath) : null;
    return previewResult(resolved, stat2, {
      kind: "pdf",
      mimeType: "application/pdf",
      isBinary: true,
      dataUrl: data ? `data:application/pdf;base64,${data.toString("base64")}` : null,
      truncated: data === null
    });
  }
  if (DOCUMENT_MIME[extension]) {
    return previewResult(resolved, stat2, {
      kind: "document",
      mimeType: DOCUMENT_MIME[extension],
      isBinary: true
    });
  }
  if (ARCHIVE_MIME[extension]) {
    return previewResult(resolved, stat2, {
      kind: "archive",
      mimeType: ARCHIVE_MIME[extension],
      isBinary: true
    });
  }
  const buffer = await readHead(resolved.absolutePath, MAX_TEXT_PREVIEW_BYTES + 1);
  const binary = isBinaryContent(buffer);
  if (binary) {
    return previewResult(resolved, stat2, {
      kind: "binary",
      mimeType: "application/octet-stream",
      isBinary: true
    });
  }
  const truncated = buffer.length > MAX_TEXT_PREVIEW_BYTES;
  const content = (truncated ? buffer.subarray(0, MAX_TEXT_PREVIEW_BYTES) : buffer).toString(
    "utf-8"
  );
  const kind = MARKDOWN_EXTENSIONS.has(extension) ? "markdown" : TABLE_EXTENSIONS.has(extension) ? "table" : "text";
  return previewResult(resolved, stat2, {
    kind,
    mimeType: textMimeType(extension),
    isBinary: false,
    content,
    language: detectLanguage(relativePath),
    truncated
  });
}
async function resolveFileReference(workspacePath, reference) {
  let cleaned = reference.trim();
  const leadingPunctuation = /* @__PURE__ */ new Set(["'", '"', "`", "(", "<", "["]);
  const trailingPunctuation = /* @__PURE__ */ new Set(["'", '"', "`", ")", ">", "]", ".", ",", ";"]);
  while (cleaned[0] && leadingPunctuation.has(cleaned[0])) cleaned = cleaned.slice(1);
  while (cleaned.at(-1) && trailingPunctuation.has(cleaned.at(-1))) {
    cleaned = cleaned.slice(0, -1);
  }
  if (cleaned.startsWith("file://")) {
    try {
      cleaned = decodeURIComponent(new URL(cleaned).pathname);
    } catch {
      return null;
    }
  } else if (cleaned.includes("%")) {
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {
      return null;
    }
  }
  const { path: pathPart, line, column } = parseLineLocation(cleaned);
  if (!pathPart) return null;
  const expandedHome = expandHome(pathPart);
  const absoluteInput = expandedHome ?? (isAbsolute(pathPart) ? resolve(pathPart) : null);
  if (absoluteInput) {
    try {
      const root = await promises.realpath(workspacePath);
      const realCandidate = await promises.realpath(absoluteInput);
      assertWithinRoot(root, realCandidate);
      const stat2 = await promises.stat(realCandidate);
      if (stat2.isFile()) {
        return resolvedFileLocation(toPosixPath(relative(root, realCandidate)), line, column);
      }
    } catch {
    }
    return resolveOutsideWorkspace(absoluteInput, pathPart, line, column);
  }
  try {
    const resolved = await resolveWorkspaceEntry(workspacePath, pathPart);
    const stat2 = await promises.stat(resolved.absolutePath);
    if (!stat2.isFile()) return null;
    return resolvedFileLocation(resolved.relativePath, line, column);
  } catch {
    const normalizedSuffix = toPosixPath(pathPart).replace(/^\.\//, "");
    const targetName = basename(normalizedSuffix);
    const matches = (await searchWorkspace(workspacePath, targetName, MAX_SEARCH_RESULTS)).filter(
      (entry) => !entry.isDirectory && entry.name === targetName && (normalizedSuffix === targetName || entry.relativePath === normalizedSuffix || entry.relativePath.endsWith(`/${normalizedSuffix}`))
    );
    if (matches.length !== 1) return null;
    return resolvedFileLocation(matches[0].relativePath, line, column);
  }
}
async function resolveOutsideWorkspace(absolutePath, displayPath, line, column) {
  try {
    const real = await promises.realpath(absolutePath);
    const stat2 = await promises.stat(real);
    if (!stat2.isFile()) return null;
    return resolvedFileLocation(displayPath, line, column, real);
  } catch {
    return null;
  }
}
function resolvedFileLocation(relativePath, line, column, absolutePath) {
  return {
    relativePath,
    ...absolutePath !== void 0 && { absolutePath },
    ...line !== void 0 && { line },
    ...column !== void 0 && { column }
  };
}
function detectLanguage(filename) {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  const map = {
    bash: "bash",
    c: "c",
    cc: "cpp",
    cjs: "javascript",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    go: "go",
    h: "c",
    hpp: "cpp",
    html: "html",
    ini: "ini",
    java: "java",
    js: "javascript",
    json: "json",
    jsonc: "json",
    jsx: "jsx",
    kt: "kotlin",
    lua: "lua",
    markdown: "markdown",
    md: "markdown",
    mjs: "javascript",
    php: "php",
    py: "python",
    rb: "ruby",
    rs: "rust",
    scss: "scss",
    sh: "bash",
    sql: "sql",
    svelte: "svelte",
    swift: "swift",
    toml: "toml",
    ts: "typescript",
    tsx: "tsx",
    vue: "vue",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    zsh: "bash"
  };
  return map[ext] ?? null;
}
function isBinaryContent(content) {
  return content.subarray(0, 8e3).includes(0);
}
async function toDirectoryEntry(absoluteParent, relativeParent, entry, ig) {
  const entryRelative = toPosixPath(relativeParent ? `${relativeParent}/${entry.name}` : entry.name);
  const lstat = await promises.lstat(resolve(absoluteParent, entry.name));
  const isSymlink = lstat.isSymbolicLink();
  let isDirectory = lstat.isDirectory();
  let size = lstat.size;
  let modifiedAt = lstat.mtimeMs;
  if (isSymlink) {
    try {
      const target = await promises.stat(resolve(absoluteParent, entry.name));
      isDirectory = target.isDirectory();
      size = target.size;
      modifiedAt = target.mtimeMs;
    } catch {
      return null;
    }
  }
  if (ig.ignores(isDirectory ? `${entryRelative}/` : entryRelative)) return null;
  return {
    name: entry.name,
    relativePath: entryRelative,
    isDirectory,
    isSymlink,
    size,
    modifiedAt
  };
}
function assertWithinRoot(root, target) {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error("path is outside the workspace");
  }
}
function expandHome(input) {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  const homeEnv = process.env.HOME;
  if (homeEnv) {
    if (input === "$HOME") return homeEnv;
    if (input.startsWith("$HOME/")) return join(homeEnv, input.slice(6));
  }
  return null;
}
function parseLineLocation(input) {
  const anchor = input.match(/^(.*)#L(\d+)(?:C(\d+))?$/);
  if (anchor) {
    const [, head, lineStr, colStr] = anchor;
    return {
      path: head.trim(),
      line: Number(lineStr),
      ...colStr !== void 0 && { column: Number(colStr) }
    };
  }
  const colon = input.match(/^([^\s:]+):(\d+)(?::(\d+))?(?:-\d+(?:\.\d+)?)?$/);
  if (colon) {
    const [, head, lineStr, colStr] = colon;
    return {
      path: head.trim(),
      line: Number(lineStr),
      ...colStr !== void 0 && { column: Number(colStr) }
    };
  }
  const paren = input.match(/^(.*)\((\d+)(?::(\d+)|, ?(\d+))?\)$/);
  if (paren) {
    const [, head, lineStr, colStr, commaColStr] = paren;
    const col = colStr ?? commaColStr;
    return {
      path: head.trim(),
      line: Number(lineStr),
      ...col !== void 0 && { column: Number(col) }
    };
  }
  const space = input.match(/^(\S+) (\d+)(?::(\d+))?$/);
  if (space) {
    const [, head, lineStr, colStr] = space;
    return {
      path: head,
      line: Number(lineStr),
      ...colStr !== void 0 && { column: Number(colStr) }
    };
  }
  return { path: input };
}
function previewResult(resolved, stat2, fields) {
  return {
    relativePath: resolved.relativePath,
    absolutePath: resolved.absolutePath,
    name: basename(resolved.absolutePath),
    size: stat2.size,
    mimeType: fields.mimeType,
    kind: fields.kind,
    isBinary: fields.isBinary,
    content: fields.content ?? null,
    dataUrl: fields.dataUrl ?? null,
    language: fields.language ?? null,
    truncated: fields.truncated ?? false,
    encoding: fields.isBinary ? "binary" : "utf-8",
    modifiedAt: stat2.mtimeMs
  };
}
function mediaType(extension) {
  if (IMAGE_MIME[extension]) return { kind: "image", mimeType: IMAGE_MIME[extension] };
  if (AUDIO_MIME[extension]) return { kind: "audio", mimeType: AUDIO_MIME[extension] };
  if (VIDEO_MIME[extension]) return { kind: "video", mimeType: VIDEO_MIME[extension] };
  return null;
}
function textMimeType(extension) {
  if (extension === "json" || extension === "jsonc") return "application/json";
  if (extension === "csv") return "text/csv";
  if (extension === "tsv") return "text/tab-separated-values";
  if (extension === "html") return "text/html";
  if (extension === "css") return "text/css";
  return "text/plain";
}
async function readHead(filePath, byteLength) {
  const file = await promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(byteLength);
    const { bytesRead } = await file.read(buffer, 0, byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
async function loadGitignore(workspacePath) {
  const ig = ignore().add(DEFAULT_IGNORE);
  try {
    ig.add(await promises.readFile(resolve(workspacePath, ".gitignore"), "utf-8"));
  } catch {
  }
  return ig;
}
function compareDirectoryEntries(a, b) {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  return a.name.localeCompare(b.name, void 0, { numeric: true, sensitivity: "base" });
}
function compareSearchResults(query2) {
  return (a, b) => {
    const aName = a.name.toLocaleLowerCase();
    const bName = b.name.toLocaleLowerCase();
    const aStarts = aName.startsWith(query2);
    const bStarts = bName.startsWith(query2);
    if (aStarts !== bStarts) return aStarts ? -1 : 1;
    return a.relativePath.localeCompare(b.relativePath, void 0, {
      numeric: true,
      sensitivity: "base"
    });
  };
}
function toPosixPath(path) {
  return path.split(sep).join("/");
}
const readDirectoryHandler = async (args) => {
  const workspace = requireWorkspace(args.workspaceId);
  return readDirectory(workspace.path, args.relativePath ?? "", args.respectGitignore ?? true);
};
const readFilePreviewHandler = async (args) => {
  const workspace = requireWorkspace(args.workspaceId);
  return readFilePreview(workspace.path, args.relativePath, args.absolutePath);
};
const searchFilesHandler = async (args) => {
  const workspace = requireWorkspace(args.workspaceId);
  return searchWorkspace(workspace.path, args.query, args.limit);
};
const resolveFileReferenceHandler = async (args) => {
  const workspace = requireWorkspace(args.workspaceId);
  return resolveFileReference(workspace.path, args.reference);
};
const openInEditorHandler = async (args) => {
  const ws = ctx.db.findWorkspaceById(args.workspaceId);
  if (!ws) {
    return { launched: false, editor: null, error: "workspace not found" };
  }
  if (!args.absolutePath) {
    try {
      await resolveWorkspaceEntry(ws.path, args.relativePath);
    } catch {
      return {
        launched: false,
        editor: null,
        error: "file is outside the workspace or unavailable"
      };
    }
  }
  const editor = ws.preferredEditor ?? DEFAULT_EDITOR;
  return launchInEditor(editor, {
    workspacePath: ws.path,
    relativePath: args.relativePath,
    ...args.absolutePath !== void 0 && { absolutePath: args.absolutePath },
    ...args.line !== void 0 && { line: args.line },
    ...args.column !== void 0 && { column: args.column }
  });
};
const pathExistsHandler = async (args) => {
  return existsSync(args.absolutePath);
};
function requireWorkspace(workspaceId) {
  const workspace = ctx.db.findWorkspaceById(workspaceId);
  if (!workspace) throw new Error("workspace not found");
  return workspace;
}
function registerFsHandlers() {
  handleRendererRequest("fs.readDirectory", readDirectoryHandler);
  handleRendererRequest(
    "fs.readFilePreview",
    readFilePreviewHandler
  );
  handleRendererRequest("fs.searchFiles", searchFilesHandler);
  handleRendererRequest(
    "fs.resolveFileReference",
    resolveFileReferenceHandler
  );
  handleRendererRequest("fs.openInEditor", openInEditorHandler);
  handleRendererRequest("fs.pathExists", pathExistsHandler);
}
const log$5 = logger.domain("git-service");
async function getGitStatus(workspacePath) {
  const gitDir = join(workspacePath, ".git");
  if (!existsSync(gitDir)) {
    return {
      isRepo: false,
      branch: null,
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      recentCommits: []
    };
  }
  try {
    const git = simpleGit(workspacePath);
    const status = await git.status();
    const recentCommits = await getRecentCommits(git, 20);
    const staged = [];
    const unstaged = [];
    const untracked = [...status.not_added];
    for (const file of status.files) {
      const change = parseFileStatus(file);
      if (file.index !== " " && file.index !== "?") {
        staged.push(change);
      }
      if (file.working_dir !== " " && file.working_dir !== "?") {
        unstaged.push(change);
      }
      if (file.index === "?" || file.working_dir === "?") {
        if (!untracked.includes(file.path)) {
          untracked.push(file.path);
        }
      }
    }
    return {
      isRepo: true,
      branch: status.current,
      ahead: status.ahead,
      behind: status.behind,
      staged,
      unstaged,
      untracked,
      recentCommits
    };
  } catch (e) {
    log$5.warn("git status failed:", e);
    return {
      isRepo: false,
      branch: null,
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      recentCommits: []
    };
  }
}
function parseFileStatus(file) {
  const code = file.index !== " " ? file.index : file.working_dir;
  let status;
  switch (code) {
    case "M":
      status = "modified";
      break;
    case "A":
      status = "added";
      break;
    case "D":
      status = "deleted";
      break;
    case "R":
      status = "renamed";
      break;
    case "C":
      status = "renamed";
      break;
    default:
      status = "unknown";
  }
  return {
    path: file.path,
    status,
    staged: file.index !== " "
  };
}
async function getRecentCommits(git, limit) {
  try {
    const result = await git.log({ maxCount: limit });
    return result.all.map((c) => ({
      hash: c.hash,
      shortHash: c.hash.slice(0, 7),
      author: c.author_name,
      date: c.date,
      message: c.message
    }));
  } catch {
    return [];
  }
}
const getGitStatusHandler = async (args) => {
  return getGitStatus(args.workspacePath);
};
function registerGitHandlers() {
  handleRendererRequest("git.status", getGitStatusHandler);
}
const createTerminal = async (args) => {
  const cwd = args.cwd === "" ? void 0 : args.cwd;
  const inst = ctx.ptyManager.create({
    ...cwd !== void 0 && { cwd },
    ...args.cols !== void 0 && { cols: args.cols },
    ...args.rows !== void 0 && { rows: args.rows }
  });
  return {
    id: inst.id,
    pid: inst.pid,
    initialCols: args.cols ?? 80,
    initialRows: args.rows ?? 24
  };
};
const writeTerminal = async (args) => {
  ctx.ptyManager.write(args.id, args.data);
};
const resizeTerminal = async (args) => {
  ctx.ptyManager.resize(args.id, args.cols, args.rows);
};
const killTerminal = async (args) => {
  ctx.ptyManager.kill(args.id);
};
function registerPtyHandlers() {
  handleRendererRequest("pty.create", createTerminal);
  handleRendererRequest("pty.write", writeTerminal);
  handleRendererRequest("pty.resize", resizeTerminal);
  handleRendererRequest("pty.kill", killTerminal);
}
const log$4 = logger.domain("session-handler");
class SessionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "SessionError";
  }
}
function toView(session2) {
  const currentBackend = ctx.backendManager.getCurrentId();
  return {
    ...session2,
    continuable: session2.backend === currentBackend,
    stale: false
  };
}
const listSessions = async (args) => {
  const records = ctx.db.listSessions(args.workspaceId, args.backend);
  return records.map(toView);
};
const createSession = async (args) => {
  const ws = ctx.db.findWorkspaceById(args.workspaceId);
  if (!ws) {
    throw new SessionError("workspace-not-found", `workspace not found: ${args.workspaceId}`);
  }
  const backend = args.backend ?? ctx.backendManager.getCurrentId();
  const startArgs = { cwd: args.cwd };
  if (args.model !== void 0) startArgs.model = args.model;
  if (args.effort !== void 0) startArgs.effort = args.effort;
  if (args.permissionMode !== void 0) startArgs.permissionMode = args.permissionMode;
  if (args.initialPrompt !== void 0) startArgs.initialPrompt = args.initialPrompt;
  const { backendThreadId } = await ctx.backendManager.startSession(startArgs);
  const now = Date.now();
  const sessionId = randomUUID();
  ctx.db.insertSession({
    id: sessionId,
    backend,
    backendThreadId,
    workspaceId: args.workspaceId,
    title: args.initialPrompt?.slice(0, 50) ?? null,
    model: args.model ?? null,
    effort: args.effort ?? null,
    permissionMode: args.permissionMode ?? null,
    turnCount: 0,
    createdAt: now,
    lastActiveAt: now
  });
  log$4.info("created session", sessionId, "backend=", backend);
  return { sessionId };
};
const removeSession = async (args) => {
  const session2 = ctx.db.findSessionById(args.sessionId);
  if (!session2) {
    throw new SessionError("not-found", `session not found: ${args.sessionId}`);
  }
  ctx.db.insertDeletedSession(session2.backend, session2.backendThreadId);
  ctx.db.deleteSession(args.sessionId);
  log$4.info(
    "removed session (soft)",
    args.sessionId,
    `(${session2.backend}/${session2.backendThreadId})`
  );
};
const reconcileSessions = async (args) => {
  const workspace = ctx.db.findWorkspaceById(args.workspaceId);
  if (!workspace) {
    throw new SessionError("workspace-not-found", `workspace not found: ${args.workspaceId}`);
  }
  const currentBackend = ctx.backendManager.getCurrentId();
  let backendSessions = [];
  try {
    backendSessions = await ctx.backendManager.listSessions(workspace.path);
  } catch (e) {
    log$4.warn("listSessions failed during reconcile, skipping backend sync:", e);
  }
  const backendThreadIds = new Set(backendSessions.map((s) => s.backendThreadId));
  const appSessions = ctx.db.listSessions(args.workspaceId, currentBackend);
  const added = [];
  for (const bs of backendSessions) {
    const exists = appSessions.find((s) => s.backendThreadId === bs.backendThreadId);
    if (exists) continue;
    if (ctx.db.isSessionDeleted(currentBackend, bs.backendThreadId)) {
      continue;
    }
    const now = Date.now();
    const sessionId = randomUUID();
    ctx.db.insertSession({
      id: sessionId,
      backend: currentBackend,
      backendThreadId: bs.backendThreadId,
      workspaceId: args.workspaceId,
      title: bs.title,
      model: bs.model,
      effort: null,
      permissionMode: null,
      turnCount: 0,
      createdAt: now,
      lastActiveAt: bs.lastActiveAt
    });
    const inserted = ctx.db.findSessionById(sessionId);
    if (inserted) added.push(toView(inserted));
  }
  const removed = [];
  for (const app2 of appSessions) {
    if (!backendThreadIds.has(app2.backendThreadId)) {
      ctx.db.markSessionStale(app2.id);
      removed.push(app2.id);
    }
  }
  log$4.info("reconciled", { added: added.length, removed: removed.length });
  return { added, removed };
};
const scanImportableSessions = async () => {
  const currentBackend = ctx.backendManager.getCurrentId();
  let summaryList = [];
  const errors = [];
  try {
    summaryList = await ctx.backendManager.listSessions();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    errors.push({ backend: currentBackend, error: message });
    log$4.warn(`listSessions failed for ${currentBackend}:`, message);
  }
  const workspaces = ctx.db.listWorkspaces();
  const encodedToWorkspace = /* @__PURE__ */ new Map();
  for (const ws of workspaces) {
    encodedToWorkspace.set(encodeCwdToProjectDir(ws.path), ws.id);
  }
  const dbThreadToWorkspace = /* @__PURE__ */ new Map();
  for (const ws of workspaces) {
    for (const s of ctx.db.listSessions(ws.id, currentBackend)) {
      dbThreadToWorkspace.set(s.backendThreadId, ws.id);
    }
  }
  const sessions = [];
  let unmatchedCount = 0;
  for (const s of summaryList) {
    if (!s.backendThreadId) continue;
    const existingWorkspaceId = dbThreadToWorkspace.get(s.backendThreadId);
    const alreadyImported = existingWorkspaceId !== void 0;
    let matchedWorkspaceId;
    if (s.cwd) {
      const encoded = encodeCwdToProjectDir(s.cwd);
      matchedWorkspaceId = encodedToWorkspace.get(encoded);
      if (!matchedWorkspaceId && !alreadyImported) {
        unmatchedCount++;
      }
    }
    const item = {
      backend: currentBackend,
      backendThreadId: s.backendThreadId,
      title: s.title,
      lastActiveAt: s.lastActiveAt,
      model: s.model,
      alreadyImported
    };
    if (s.cwd !== void 0) item.cwd = s.cwd;
    if (s.sizeBytes !== void 0) item.sizeBytes = s.sizeBytes;
    if (existingWorkspaceId !== void 0) item.existingWorkspaceId = existingWorkspaceId;
    if (matchedWorkspaceId !== void 0) item.matchedWorkspaceId = matchedWorkspaceId;
    sessions.push(item);
  }
  sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  log$4.info("scanImportable", {
    total: sessions.length,
    alreadyImported: sessions.filter((s) => s.alreadyImported).length,
    unmatched: unmatchedCount,
    errors: errors.length
  });
  return { sessions, unmatchedCount, errors };
};
const importSessions = async (args) => {
  const workspaces = ctx.db.listWorkspaces();
  const workspaceById = /* @__PURE__ */ new Map();
  for (const ws of workspaces) workspaceById.set(ws.id, ws);
  const imported = [];
  const skipped = [];
  for (const item of args.sessions) {
    const ws = workspaceById.get(item.workspaceId);
    if (!ws) {
      skipped.push({
        backendThreadId: item.backendThreadId,
        reason: `workspace not found: ${item.workspaceId}`
      });
      continue;
    }
    const existing = ctx.db.findSessionByBackendThreadId(item.backend, item.backendThreadId);
    if (existing) {
      skipped.push({
        backendThreadId: item.backendThreadId,
        reason: `already imported (session ${existing.id})`
      });
      continue;
    }
    let title = item.title ?? null;
    if (!title && item.backend === "claude") {
      try {
        const { aiTitle } = await ctx.backendManager.getHistory(
          item.backend,
          item.backendThreadId,
          ws.path
        );
        title = aiTitle ?? null;
      } catch (e) {
        log$4.warn(
          `importSessions: getHistory failed for ${item.backend}:${item.backendThreadId}, using fallback title:`,
          e
        );
      }
    }
    if (!title) {
      title = item.backendThreadId.slice(0, 8);
    }
    const lastActiveAt = item.lastActiveAt ?? Date.now();
    const sessionId = randomUUID();
    ctx.db.insertSession({
      id: sessionId,
      backend: item.backend,
      backendThreadId: item.backendThreadId,
      workspaceId: item.workspaceId,
      title,
      model: item.model ?? null,
      effort: null,
      permissionMode: null,
      turnCount: 0,
      // 没拿到磁盘记录的创建时间，用 lastActiveAt 代替
      createdAt: lastActiveAt,
      lastActiveAt
    });
    const inserted = ctx.db.findSessionById(sessionId);
    if (inserted) {
      imported.push(toView(inserted));
      log$4.info("imported session", sessionId, `(${item.backend})`);
    }
  }
  log$4.info("importSessions done", { imported: imported.length, skipped: skipped.length });
  return { imported, skipped };
};
const getSessionDetail = async (args) => {
  const session2 = ctx.db.findSessionById(args.sessionId);
  if (!session2) {
    throw new SessionError("not-found", `session not found: ${args.sessionId}`);
  }
  const workspace = ctx.db.findWorkspaceById(session2.workspaceId);
  const cwd = workspace?.path;
  const { messages, aiTitle } = await ctx.backendManager.getHistory(
    session2.backend,
    session2.backendThreadId,
    cwd
  );
  let updatedSession = session2;
  if (aiTitle && aiTitle !== session2.title) {
    ctx.db.updateSessionTitle(session2.id, aiTitle);
    log$4.info("updated session title from backend", session2.id, aiTitle);
    updatedSession = ctx.db.findSessionById(session2.id) ?? session2;
  }
  return {
    session: toView(updatedSession),
    messages,
    aiTitle
  };
};
const readSubagentHistory = async (args) => {
  const status = await ctx.backendManager.getStatus(args.backend);
  if (!status.capabilities.chat.subAgents) return [];
  return readSubagentHistory$1(args.agentId, args.cwd);
};
const updateSessionConfig = async (args) => {
  const session2 = ctx.db.findSessionById(args.sessionId);
  if (!session2) {
    throw new SessionError("not-found", `session not found: ${args.sessionId}`);
  }
  ctx.db.updateSessionConfig(args.sessionId, {
    model: args.model,
    effort: args.effort,
    permissionMode: args.permissionMode
  });
};
const getLastRuntimeConfig = async () => {
  const raw = ctx.db.getState(STORAGE_KEYS.LAST_RUNTIME_CONFIG);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    log$4.warn("failed to parse last runtime config, ignoring:", e);
    return null;
  }
};
const setLastRuntimeConfig = async (args) => {
  ctx.db.setState(STORAGE_KEYS.LAST_RUNTIME_CONFIG, JSON.stringify(args));
};
function registerSessionHandlers() {
  handleRendererRequest("session.list", listSessions);
  handleRendererRequest("session.create", createSession);
  handleRendererRequest("session.remove", removeSession);
  handleRendererRequest(
    "session.reconcile",
    reconcileSessions
  );
  handleRendererRequest(
    "session.scanImportable",
    scanImportableSessions
  );
  handleRendererRequest("session.import", importSessions);
  handleRendererRequest("session.detail", getSessionDetail);
  handleRendererRequest(
    "session.readSubagentHistory",
    readSubagentHistory
  );
  handleRendererRequest(
    "session.updateConfig",
    updateSessionConfig
  );
  handleRendererRequest(
    "session.getLastRuntimeConfig",
    getLastRuntimeConfig
  );
  handleRendererRequest(
    "session.setLastRuntimeConfig",
    setLastRuntimeConfig
  );
}
const log$3 = logger.domain("settings-handler");
const getSettings = async () => {
  return ctx.settingsStore.load();
};
const updateSettings = async (args) => {
  const updated = ctx.settingsStore.update(args.patch);
  try {
    ctx.backendManager.applySettings(updated);
  } catch (e) {
    log$3.warn("applySettings after update failed:", e);
  }
  return updated;
};
const resetSettings = async () => {
  const reset = ctx.settingsStore.reset();
  try {
    ctx.backendManager.applySettings(reset);
  } catch (e) {
    log$3.warn("applySettings after reset failed:", e);
  }
  return reset;
};
function registerSettingsHandlers() {
  handleRendererRequest("settings.get", getSettings);
  handleRendererRequest("settings.update", updateSettings);
  handleRendererRequest("settings.reset", resetSettings);
}
const getPlatformInfo = async () => {
  return {
    platform: process.platform,
    arch: process.arch,
    osVersion: process.getSystemVersion(),
    appVersion: process.env["npm_package_version"] ?? "0.0.0",
    electronVersion: process.versions.electron
  };
};
const openDialog = async (args) => {
  const win = ctx.getMainWindow();
  const options = {
    properties: args.properties ?? ["openDirectory"]
  };
  if (args.title !== void 0) options.title = args.title;
  if (args.defaultPath !== void 0) options.defaultPath = args.defaultPath;
  const result = await dialog.showOpenDialog(win, options);
  return { canceled: result.canceled, filePaths: result.filePaths };
};
const openExternal = async (args) => {
  await shell.openExternal(args.url);
};
const detectProxy = async () => {
  if (process.platform === "linux") {
    const url = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
    if (url) {
      return {
        enabled: true,
        url,
        bypass: process.env.NO_PROXY ?? process.env.no_proxy ?? null,
        source: "linux-env"
      };
    }
    return { enabled: false, url: "", bypass: null, source: "none" };
  }
  if (process.platform === "darwin") {
    try {
      const { execSync } = await import("node:child_process");
      const output = execSync("scutil --proxy", { encoding: "utf-8", timeout: 3e3 });
      const parsed = parseSystemProxy(output);
      if (parsed) {
        return { ...parsed, source: "macos-scutil" };
      }
      return { enabled: false, url: "", bypass: null, source: "none" };
    } catch {
      return { enabled: false, url: "", bypass: null, source: "none" };
    }
  }
  if (process.platform === "win32") {
    try {
      const { execSync } = await import("node:child_process");
      const regQuery = (key) => execSync(
        `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ${key}`,
        {
          encoding: "utf-8",
          timeout: 3e3
        }
      ).trim();
      const enableStr = regQuery("ProxyEnable");
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(enableStr);
      if (!enabled) {
        return { enabled: false, url: "", bypass: null, source: "none" };
      }
      const serverStr = regQuery("ProxyServer");
      const m = serverStr.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
      const host = m?.[1] ?? "";
      const bypassStr = regQuery("ProxyOverride");
      const bm = bypassStr.match(/ProxyOverride\s+REG_SZ\s+(\S*)/);
      const bypass = bm?.[1] || null;
      const url = /^https?:\/\//.test(host) ? host : `http://${host}`;
      return { enabled: true, url, bypass, source: "windows-registry" };
    } catch {
      return { enabled: false, url: "", bypass: null, source: "none" };
    }
  }
  return { enabled: false, url: "", bypass: null, source: "none" };
};
const windowMinimize = async () => {
  const win = ctx.getMainWindow();
  if (win) win.minimize();
};
const windowMaximize = async () => {
  const win = ctx.getMainWindow();
  if (!win) return;
  if (process.platform === "darwin") {
    win.setFullScreen(!win.isFullScreen());
  } else if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
};
const windowClose = async () => {
  const win = ctx.getMainWindow();
  if (win) win.close();
};
const windowIsMaximized = async () => {
  const win = ctx.getMainWindow();
  if (!win) return false;
  return process.platform === "darwin" ? win.isFullScreen() : win.isMaximized();
};
const saveImage = async (args) => {
  const win = ctx.getMainWindow();
  const { url, suggestedName } = args;
  const defaultName = suggestedName || inferImageName(url);
  const result = await dialog.showSaveDialog(win, {
    title: "保存图片",
    defaultPath: defaultName,
    filters: [
      { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
      { name: "所有文件", extensions: ["*"] }
    ]
  });
  if (result.canceled || !result.filePath) return null;
  if (url.startsWith("data:")) {
    const parsed = parseDataUrl(url);
    if (!parsed) throw new Error("无法解析 data:URL");
    writeFileSync(result.filePath, parsed.data);
    return result.filePath;
  }
  const response = await net.fetch(url);
  if (!response.ok) {
    throw new Error(`下载失败：HTTP ${response.status}`);
  }
  const buffer = Buffer$1.from(await response.arrayBuffer());
  writeFileSync(result.filePath, buffer);
  return result.filePath;
};
function parseDataUrl(url) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  const mime = match[1] ?? "image/png";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? "";
  const data = isBase64 ? Buffer$1.from(payload, "base64") : Buffer$1.from(decodeURIComponent(payload));
  return { mime, data };
}
function inferImageName(url) {
  if (url.startsWith("data:")) {
    const mime = /^data:([^;,]+)/.exec(url)?.[1] ?? "image/png";
    const ext = mime.split("/")[1]?.split("+")[0] ?? "png";
    return `image.${ext}`;
  }
  try {
    const u = new URL(url);
    const base = u.pathname.split("/").pop()?.split("?")[0] ?? "";
    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(base)) return base;
    return `${base || "image"}.png`;
  } catch {
    return "image.png";
  }
}
function registerSystemHandlers() {
  handleRendererRequest(
    "system.platformInfo",
    getPlatformInfo
  );
  handleRendererRequest("system.openDialog", openDialog);
  handleRendererRequest("system.openExternal", openExternal);
  handleRendererRequest("system.detectProxy", detectProxy);
  handleRendererRequest(
    "system.windowMinimize",
    windowMinimize
  );
  handleRendererRequest(
    "system.windowMaximize",
    windowMaximize
  );
  handleRendererRequest("system.windowClose", windowClose);
  handleRendererRequest(
    "system.windowIsMaximized",
    windowIsMaximized
  );
  handleRendererRequest("system.saveImage", saveImage);
}
const log$2 = logger.domain("workspace-handler");
class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "WorkspaceError";
  }
}
const listWorkspaces = async () => {
  return ctx.db.listWorkspaces();
};
const addWorkspace = async (args) => {
  const path = args.path.trim();
  if (!path) throw new WorkspaceError("invalid-path", "path is empty");
  if (!existsSync(path)) {
    throw new WorkspaceError("invalid-path", `path does not exist: ${path}`);
  }
  const stat2 = statSync(path);
  if (!stat2.isDirectory()) {
    throw new WorkspaceError("invalid-path", `path is not a directory: ${path}`);
  }
  const existing = ctx.db.findWorkspaceByPath(path);
  if (existing) {
    throw new WorkspaceError("already-exists", `workspace already added: ${path}`);
  }
  const now = Date.now();
  const record = {
    id: randomUUID(),
    path,
    name: args.name?.trim() || basename(path),
    preferredEditor: null,
    lastOpenedAt: now,
    createdAt: now
  };
  ctx.db.insertWorkspace(record);
  log$2.info("added", record.id, record.path);
  return record;
};
const removeWorkspace = async (args) => {
  const existing = ctx.db.findWorkspaceById(args.id);
  if (!existing) throw new WorkspaceError("not-found", `workspace not found: ${args.id}`);
  ctx.db.deleteWorkspace(args.id);
  log$2.info("removed", args.id);
};
const renameWorkspace = async (args) => {
  const existing = ctx.db.findWorkspaceById(args.id);
  if (!existing) throw new WorkspaceError("not-found", `workspace not found: ${args.id}`);
  const name = args.name.trim();
  if (!name) throw new WorkspaceError("invalid-path", "name cannot be empty");
  ctx.db.updateWorkspaceName(args.id, name);
};
const setWorkspaceEditor = async (args) => {
  const existing = ctx.db.findWorkspaceById(args.id);
  if (!existing) throw new WorkspaceError("not-found", `workspace not found: ${args.id}`);
  ctx.db.updateWorkspaceEditor(args.id, args.editor);
};
const touchWorkspace = async (args) => {
  const existing = ctx.db.findWorkspaceById(args.id);
  if (!existing) throw new WorkspaceError("not-found", `workspace not found: ${args.id}`);
  ctx.db.touchWorkspace(args.id, Date.now());
};
function registerWorkspaceHandlers() {
  handleRendererRequest("workspace.list", listWorkspaces);
  handleRendererRequest("workspace.add", addWorkspace);
  handleRendererRequest("workspace.remove", removeWorkspace);
  handleRendererRequest("workspace.rename", renameWorkspace);
  handleRendererRequest(
    "workspace.setEditor",
    setWorkspaceEditor
  );
  handleRendererRequest("workspace.touch", touchWorkspace);
}
const log$1 = logger.domain("ipc-register");
async function registerAllHandlers() {
  registerWorkspaceHandlers();
  registerSettingsHandlers();
  registerSystemHandlers();
  registerBackendHandlers();
  registerSessionHandlers();
  registerGitHandlers();
  registerFsHandlers();
  registerPtyHandlers();
  log$1.info("all handlers registered");
}
function resolveIconPath() {
  const candidates = [
    join(app.getAppPath(), "resources/icon.png"),
    // dev / packaged app root
    join(process.resourcesPath, "icon.png"),
    // packaged asarUnpack 兜底
    join(__dirname, "../resources/icon.png")
    // 旧路径兜底
  ];
  return candidates.find((p) => existsSync(p));
}
function resolvePreloadPath() {
  const dir = join(__dirname, "../preload");
  for (const filename of ["index.mjs", "index.js"]) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
  }
  return join(dir, "index.js");
}
function createMainWindow() {
  const iconPath = resolveIconPath();
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : void 0;
  if (icon && process.platform === "darwin" && app.dock) {
    app.dock.setIcon(icon);
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    frame: false,
    // 完全移除窗口框架
    autoHideMenuBar: true,
    title: "Catmax",
    ...icon ? { icon } : {},
    // Windows 任务栏图标（macOS 见上面的 dock.setIcon）
    backgroundColor: "#18181b",
    // 与 dark theme --background 接近，避免白闪
    webPreferences: {
      preload: resolvePreloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.on("ready-to-show", () => {
    win.show();
  });
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: "deny" };
  });
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    win.webContents.openDevTools();
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
  ctx.registerWindow("main", win);
  return win;
}
const log = logger.domain("main");
if (is.dev) {
  app.commandLine.appendSwitch("remote-debugging-port", "9223");
  app.commandLine.appendSwitch("remote-allow-origins", "*");
}
fixPath();
void app.whenReady().then(async () => {
  log.info("app ready", app.getVersion());
  log.info("PATH after fix-path:", process.env.PATH);
  ctx.db.migrate();
  ctx.backendManager.recoverInterruptedTurns();
  ctx.settingsStore.load();
  ctx.backendManager.applySettings(ctx.settingsStore.load());
  log.info("database + settings ready");
  registerAllHandlers();
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});
app.on("before-quit", async (event) => {
  event.preventDefault();
  await ctx.backendManager.dispose();
  ctx.ptyManager.killAll();
  app.exit(0);
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, url) => {
    const parsed = new URL(url);
    if (!parsed.protocol.startsWith("http") && parsed.protocol !== "file:") {
      event.preventDefault();
    }
  });
});
