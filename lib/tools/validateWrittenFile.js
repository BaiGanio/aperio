/**
 * Post-write validation for write_file / edit_file / append_file.
 *
 * Dispatches by file extension to a cheap syntax check. Validators are
 * intentionally limited to checks that are (a) already a dep or in-process,
 * (b) sub-200ms in the worst case, and (c) catch the failure mode that
 * actually happens — the model writes a corrupted file and the next turn
 * proceeds as if everything is fine.
 *
 * Add more languages here as needed; each branch should be self-contained
 * and fail-open (return ok:true) on internal errors so a bug in the
 * validator never blocks a legitimate write.
 *
 * Returns: { ok, lang?, message? }
 */

import { existsSync, readFileSync } from "fs";
import { extname } from "path";
import { spawn } from "child_process";
import logger from "../helpers/logger.js";

function checkJs(targetPath) {
  return new Promise((res) => {
    const chunks = [];
    let child;
    try {
      child = spawn("node", ["--check", targetPath], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return res({ ok: true });
    }
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => chunks.push(c));
    child.on("close", (code) => {
      if (code === 0) return res({ ok: true, lang: "JavaScript" });
      const out = Buffer.concat(chunks).toString("utf-8").trim().slice(0, 600);
      res({ ok: false, lang: "JavaScript", message: out || `node --check exited ${code}` });
    });
    child.on("error", () => res({ ok: true }));
  });
}

function checkJson(targetPath) {
  try {
    const txt = readFileSync(targetPath, "utf-8");
    JSON.parse(txt);
    return { ok: true, lang: "JSON" };
  } catch (err) {
    return { ok: false, lang: "JSON", message: err.message };
  }
}

let _xmlValidator = null;
async function getXmlValidator() {
  if (_xmlValidator) return _xmlValidator;
  const mod = await import("fast-xml-parser");
  _xmlValidator = mod.XMLValidator;
  return _xmlValidator;
}

async function checkXml(targetPath) {
  try {
    const txt = readFileSync(targetPath, "utf-8");
    const Validator = await getXmlValidator();
    // XMLValidator.validate returns `true` on success or an object describing
    // the first error. It catches unclosed tags, mismatched names, bad
    // attribute syntax, etc. — the things XMLParser silently accepts.
    const result = Validator.validate(txt, { allowBooleanAttributes: true });
    if (result === true) return { ok: true, lang: "XML" };
    const e = result?.err;
    const msg = e ? `${e.code}: ${e.msg}${e.line ? ` (line ${e.line}, col ${e.col})` : ""}` : "invalid XML";
    return { ok: false, lang: "XML", message: msg };
  } catch (err) {
    return { ok: false, lang: "XML", message: err.message };
  }
}

export async function validateWrittenFile(targetPath) {
  if (typeof targetPath !== "string" || !targetPath) return { ok: true };
  if (!existsSync(targetPath)) return { ok: true }; // could be a deleted target — nothing to check

  const ext = extname(targetPath).toLowerCase();

  try {
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return await checkJs(targetPath);
    if (ext === ".json") return checkJson(targetPath);
    if (ext === ".xml" || ext === ".rels") return await checkXml(targetPath);
    return { ok: true }; // no validator for this type
  } catch (err) {
    // Fail-open: a bug in a validator must never block a legitimate write.
    logger.error(`[validateWrittenFile] internal error validating ${targetPath}: ${err.message}`);
    return { ok: true };
  }
}
