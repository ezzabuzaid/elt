import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  parseBinaryPlist
} from "./chunk-EGVP22HT.mjs";

// packages/sources/apple/macos/dist/plutil.js
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execute = promisify(execFile);
async function readMailPlist(path) {
  const { stdout } = await execute("/usr/bin/plutil", ["-convert", "binary1", "-o", "-", path], { encoding: "buffer" });
  return parseBinaryPlist(stdout);
}

export {
  readMailPlist
};
