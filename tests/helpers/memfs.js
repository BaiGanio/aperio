// tests/helpers/memfs.js
//
// Shared in-memory filesystem for tests — ZERO real disk access.
//
// Patches the CJS `fs` and `fs/promises` module objects (the same objects an
// ESM module's named `fs` imports read from) so any code under test that calls
// readFileSync / writeFileSync / readdir / stat / … operates against an in-RAM
// Map instead of the user's machine.
//
// Usage (install BEFORE dynamically importing the module under test, so its
// named fs bindings pick up the patches):
//
//   import { installMemfs } from "../../helpers/memfs.js";
//   const mem = installMemfs();                 // root defaults to "/mem"
//   mem.mkdirp(mem.root);
//   mem.writeFile(`${mem.root}/a.md`, "# A");
//   const { thing } = await import("../../../lib/thing.js");
//   ...
//   after(() => mem.restore());
//
// Paths NOT under the configured root fall through to the REAL fs, so the
// module graph (winston, native bindings, etc.) still loads normally.

import { mock } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function installMemfs({ root = "/mem" } = {}) {
  const fsSync  = require("fs");
  const fsProm  = require("fs/promises");

  // Save real refs for fall-through on out-of-root paths.
  const real = {
    existsSync:   fsSync.existsSync,
    statSync:     fsSync.statSync,
    lstatSync:    fsSync.lstatSync,
    readFileSync: fsSync.readFileSync,
    readdirSync:  fsSync.readdirSync,
    readFile:     fsProm.readFile,
    stat:         fsProm.stat,
    readdir:      fsProm.readdir,
  };

  // path -> { type: "file"|"dir", content: Buffer, mode: number, mtimeMs: number }
  const vfs = new Map();
  let clock = 1;
  const inRoot = (p) => typeof p === "string" && (p === root || p.startsWith(root + "/"));

  const enoent = (op, p) => Object.assign(new Error(`ENOENT: ${op} '${p}'`), { code: "ENOENT", path: p });
  const eacces = (op, p) => Object.assign(new Error(`EACCES: ${op} '${p}'`), { code: "EACCES", path: p });

  function mkdirp(p) {
    p.split("/").filter(Boolean).reduce((acc, part) => {
      const cur = `${acc}/${part}`;
      if (!vfs.has(cur)) vfs.set(cur, { type: "dir", content: Buffer.alloc(0), mode: 0o755, mtimeMs: clock++ });
      return cur;
    }, "");
    return p;
  }

  function writeFile(p, data) {
    const parent = p.slice(0, p.lastIndexOf("/"));
    if (parent && !vfs.has(parent)) throw enoent("open", p);
    const buf = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data));
    vfs.set(p, { type: "file", content: buf, mode: 0o644, mtimeMs: clock++ });
    return p;
  }

  function makeStat(e) {
    return {
      size: e.content.length,
      mode: e.mode,
      mtimeMs: e.mtimeMs,
      mtime: new Date(e.mtimeMs),
      isDirectory:    () => e.type === "dir",
      isFile:         () => e.type === "file",
      isSymbolicLink: () => false,
    };
  }

  function makeDirent(name, e) {
    return {
      name,
      isDirectory:    () => e.type === "dir",
      isFile:         () => e.type === "file",
      isSymbolicLink: () => false,
    };
  }

  function readEntry(op, p) {
    const e = vfs.get(p);
    if (!e || e.type !== "file") throw enoent(op, p);
    if (e.mode === 0) throw eacces(op, p);  // chmod 000 → unreadable
    return e;
  }

  function decode(buf, opts) {
    const enc = typeof opts === "string" ? opts : opts?.encoding;
    return enc ? buf.toString(enc) : Buffer.from(buf);
  }

  function listDir(op, p) {
    const e = vfs.get(p);
    if (!e || e.type !== "dir") throw enoent(op, p);
    const names = new Set();
    for (const key of vfs.keys()) {
      if (key.startsWith(p + "/")) {
        const seg = key.slice(p.length + 1).split("/")[0];
        if (seg) names.add(seg);
      }
    }
    return [...names].sort();
  }

  // ─── Sync ──────────────────────────────────────────────────────────────────
  mock.method(fsSync, "existsSync", (p) => inRoot(p) ? vfs.has(p) : real.existsSync(p));

  mock.method(fsSync, "statSync", (p, ...a) => {
    if (!inRoot(p)) return real.statSync(p, ...a);
    const e = vfs.get(p);
    if (!e) throw enoent("stat", p);
    return makeStat(e);
  });
  mock.method(fsSync, "lstatSync", (p, ...a) => {
    if (!inRoot(p)) return real.lstatSync(p, ...a);
    const e = vfs.get(p);
    if (!e) throw enoent("lstat", p);
    return makeStat(e);
  });

  mock.method(fsSync, "readFileSync", (p, opts) =>
    inRoot(p) ? decode(readEntry("open", p).content, opts) : real.readFileSync(p, opts));

  mock.method(fsSync, "readdirSync", (p, opts) => {
    if (!inRoot(p)) return real.readdirSync(p, opts);
    const names = listDir("scandir", p);
    return opts?.withFileTypes ? names.map((n) => makeDirent(n, vfs.get(`${p}/${n}`))) : names;
  });

  mock.method(fsSync, "writeFileSync", (p, data) => {
    if (!inRoot(p)) throw new Error(`memfs: refusing real writeFileSync outside ${root}: ${p}`);
    writeFile(p, data);
  });
  mock.method(fsSync, "mkdirSync", (p, opts) => {
    if (!inRoot(p)) throw new Error(`memfs: refusing real mkdirSync outside ${root}: ${p}`);
    if (opts?.recursive) return mkdirp(p);
    const parent = p.slice(0, p.lastIndexOf("/"));
    if (parent && !vfs.has(parent)) throw enoent("mkdir", p);
    vfs.set(p, { type: "dir", content: Buffer.alloc(0), mode: 0o755, mtimeMs: clock++ });
  });
  mock.method(fsSync, "chmodSync", (p, mode) => {
    const e = vfs.get(p);
    if (!e) throw enoent("chmod", p);
    e.mode = mode;
  });
  mock.method(fsSync, "unlinkSync", (p) => { if (inRoot(p)) vfs.delete(p); });
  mock.method(fsSync, "rmSync", (p, opts) => {
    if (!inRoot(p)) return;
    if (opts?.recursive) { for (const k of [...vfs.keys()]) if (k === p || k.startsWith(p + "/")) vfs.delete(k); }
    else vfs.delete(p);
  });
  mock.method(fsSync, "appendFileSync", (p, data) => {
    const e = vfs.get(p);
    const add = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    vfs.set(p, { type: "file", content: e ? Buffer.concat([e.content, add]) : add, mode: e?.mode ?? 0o644, mtimeMs: clock++ });
  });

  // ─── Promises ────────────────────────────────────────────────────────────────
  mock.method(fsProm, "readFile", async (p, opts) =>
    inRoot(p) ? decode(readEntry("open", p).content, opts) : real.readFile(p, opts));
  mock.method(fsProm, "stat", async (p, ...a) => {
    if (!inRoot(p)) return real.stat(p, ...a);
    const e = vfs.get(p);
    if (!e) throw enoent("stat", p);
    return makeStat(e);
  });
  mock.method(fsProm, "readdir", async (p, opts) => {
    if (!inRoot(p)) return real.readdir(p, opts);
    const names = listDir("scandir", p);
    return opts?.withFileTypes ? names.map((n) => makeDirent(n, vfs.get(`${p}/${n}`))) : names;
  });
  mock.method(fsProm, "writeFile", async (p, data) => { if (!inRoot(p)) throw new Error(`memfs: refusing real writeFile outside ${root}`); writeFile(p, data); });
  mock.method(fsProm, "mkdir", async (p, opts) => { if (inRoot(p)) (opts?.recursive ? mkdirp(p) : vfs.set(p, { type: "dir", content: Buffer.alloc(0), mode: 0o755, mtimeMs: clock++ })); });
  mock.method(fsProm, "rm", async (p, opts) => {
    if (!inRoot(p)) return;
    if (opts?.recursive) { for (const k of [...vfs.keys()]) if (k === p || k.startsWith(p + "/")) vfs.delete(k); }
    else vfs.delete(p);
  });
  mock.method(fsProm, "unlink", async (p) => { if (inRoot(p)) vfs.delete(p); });

  mkdirp(root);

  return {
    root,
    vfs,
    // The PATCHED fs / fs.promises objects. Tests must use these (or the helpers
    // below) rather than a static `import from "fs"`: a static import would
    // create the builtin fs ESM facade — snapshotting the ORIGINAL named exports
    // — before installMemfs() patches, leaving the module under test unmocked.
    fs:  fsSync,
    fsp: fsProm,
    mkdirp,
    writeFile,
    chmod: (p, mode) => { const e = vfs.get(p); if (e) e.mode = mode; },
    rm: (p) => vfs.delete(p),
    exists: (p) => vfs.has(p),
    read: (p) => vfs.get(p)?.content,
    reset: () => { vfs.clear(); mkdirp(root); },
    restore: () => { mock.restoreAll(); vfs.clear(); },
  };
}
