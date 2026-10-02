import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  isDictionary,
  parseBinaryPlist
} from "./chunk-462G4OOY.mjs";

// apps/apple/connectors/dist/platform/macos/mail-store.js
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtempDisposable, readFile, readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
var execute = promisify(execFile);
var mailDirectory = join(homedir(), "Library/Mail");
var MailUnavailableError = class extends Error {
  name = "MailUnavailableError";
  constructor(path, cause) {
    super(`Mail's store at ${path} cannot be read. Grant the exporting process Full Disk Access in System Settings > Privacy & Security.`, { cause });
  }
};
var MailSchemaError = class extends Error {
  name = "MailSchemaError";
};
var MailChangingError = class extends Error {
  name = "MailChangingError";
};
async function readMailPlist(path) {
  const { stdout } = await execute("/usr/bin/plutil", ["-convert", "binary1", "-o", "-", path], { encoding: "buffer" });
  return parseBinaryPlist(stdout);
}
function plistJSON(value) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item instanceof Uint8Array ? Buffer.from(item).toString("base64") : item);
}
function plistObject(value) {
  if (!isDictionary(value))
    throw new MailSchemaError("Mail returned a non-dictionary property list");
  return value;
}
async function mailVersionDirectory(root) {
  const info = plistObject(await readMailPlist(join(root, "PersistenceInfo.plist")));
  const version = info.LastUsedVersionDirectoryName;
  if (typeof version !== "string" || !/^V\d+$/.test(version))
    throw new MailSchemaError("Mail has no valid current version directory");
  return join(root, version);
}
async function inspectMailFile(path) {
  const info = await stat(path, { bigint: true });
  if (!info.isFile())
    throw new MailSchemaError(`Mail content is not a regular file: ${path}`);
  return {
    path,
    size: Number(info.size),
    version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  };
}
async function assertMailFile(file) {
  const current = await inspectMailFile(file.path).catch((cause) => {
    throw new MailChangingError(`Mail removed a file during extraction: ${file.path}`, { cause });
  });
  if (current.version !== file.version)
    throw new MailChangingError(`Mail changed a file during extraction: ${file.path}`);
}
async function hashMailFile(file) {
  await assertMailFile(file);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file.path))
    hash.update(chunk);
  await assertMailFile(file);
  return hash.digest("hex");
}
var MailStore = class _MailStore {
  messages = /* @__PURE__ */ new Map();
  attachments = /* @__PURE__ */ new Map();
  plists = /* @__PURE__ */ new Map();
  signatures = [];
  path;
  database;
  scratch;
  resources;
  constructor(path, database, scratch, resources) {
    this.path = path;
    this.database = database;
    this.scratch = scratch;
    this.resources = resources;
  }
  static async open(root, required) {
    let path;
    let database;
    try {
      path = await mailVersionDirectory(root);
      database = new DatabaseSync(join(path, "MailData/Envelope Index"), {
        readOnly: true
      });
    } catch (cause) {
      if (cause instanceof MailSchemaError)
        throw cause;
      throw new MailUnavailableError(root, cause);
    }
    const resources = new AsyncDisposableStack();
    resources.use(database);
    try {
      database.exec("BEGIN");
      const missing = Object.entries(required).flatMap(([table, columns]) => {
        const present = new Set(database.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((row) => row.name));
        return columns.filter((column) => !present.has(column)).map((column) => `${table}.${column}`);
      });
      if (missing.length)
        throw new MailSchemaError(`Unsupported Mail index schema: missing ${missing.join(", ")}`);
      const scratch = resources.use(await mkdtempDisposable(join(tmpdir(), "apple-mail-")));
      const store = new _MailStore(path, database, scratch, resources);
      const entries = await readdir(path, {
        recursive: true,
        withFileTypes: true
      });
      for (const entry of entries) {
        if (!entry.isFile())
          continue;
        const filePath = join(entry.parentPath, entry.name);
        const segments = relative(path, filePath).split(sep);
        const attachment = segments.indexOf("Attachments");
        if (/^\d+(\.partial)?\.emlx$/.test(entry.name)) {
          const id = entry.name.slice(0, entry.name.indexOf("."));
          if (store.messages.has(id))
            throw new MailSchemaError(`Mail has more than one file for indexed message ${id}`);
          store.messages.set(id, await inspectMailFile(filePath));
        } else if (attachment !== -1 && segments.length >= attachment + 4) {
          const key = `${segments[attachment + 1]}:${segments[attachment + 2]}`;
          const files = store.attachments.get(key);
          const file = await inspectMailFile(filePath);
          if (files === void 0)
            store.attachments.set(key, [file]);
          else
            files.push(file);
        } else if (entry.name.endsWith(".plist")) {
          store.plists.set(relative(path, filePath), await inspectMailFile(filePath));
        } else if (entry.name.endsWith(".mailsignature")) {
          store.signatures.push(await inspectMailFile(filePath));
        }
      }
      return store;
    } catch (error) {
      await resources.disposeAsync();
      throw error;
    }
  }
  async plist(name) {
    const file = this.plists.get(name);
    if (file === void 0)
      return null;
    await assertMailFile(file);
    const value = await readMailPlist(file.path);
    await assertMailFile(file);
    return value;
  }
  async signature(file) {
    await assertMailFile(file);
    const content = await readFile(file.path, "utf8");
    await assertMailFile(file);
    return { id: basename(file.path, ".mailsignature"), content };
  }
  async [Symbol.asyncDispose]() {
    await this.resources.disposeAsync();
  }
};

export {
  mailDirectory,
  MailSchemaError,
  readMailPlist,
  plistJSON,
  plistObject,
  mailVersionDirectory,
  assertMailFile,
  hashMailFile,
  MailStore
};
