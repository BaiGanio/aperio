// lib/terminal/ui.js
// Stateless presentational output: welcome/help/status/config/sessions
// printers and the language-selection helpers. No module-level mutable state
// beyond what chat-utils.js / sessions.js already own.

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  R, BOLD, DIM, CYAN, GRAY, GREEN, YELLOW, RED,
  getHeaderInfo,
} from "../utils/chat-utils.js";
import { init as initSessions, listSessions } from "../helpers/sessions.js";
import { readCliPrefs, writeCliPrefs } from "../helpers/cliPrefs.js";
import { resolveStrings } from "./strings.js";
import { LANG_NAMES } from "../agent/language.js";
import { parseLang } from "./commands.js";
import { configSourceLabel } from "../config-resolver.js";
import { llamacppCtxStatus } from "../providers/index.js";

// ── resolveLang — terminal locale: saved pref → env → English ─────────────────
// The in-chat `lang` command writes the pref, so it deliberately wins over
// APERIO_UI_LANG (set in .env) — otherwise a saved choice wouldn't stick.
export function resolveLang() {
  const valid = (c) => (c && LANG_NAMES[c] ? c : null);
  const pref  = valid((readCliPrefs().lang || "").toLowerCase());
  const env   = valid((process.env.APERIO_UI_LANG || "").toLowerCase());
  return pref || env || "en";
}

// A dimmed, multi-column "code name" list of every selectable language, so the
// bare `lang` command (and an unknown code) shows what can be chosen.
export function langListBlock() {
  const entries = Object.entries(LANG_NAMES).map(([c, n]) => `${c} ${n}`);
  const colW = Math.max(...entries.map((e) => e.length)) + 3;
  const perRow = 4;
  let out = "";
  for (let i = 0; i < entries.length; i += perRow) {
    out += `    ${entries.slice(i, i + perRow).map((e) => e.padEnd(colW)).join("")}\n`;
  }
  return out;
}

// Handle `lang` / `lang <code>`: bare shows the current choice + the list; a
// known code switches and persists (so it sticks next session). Returns the
// active lang.
export function handleLangCommand(cmd, currentLang) {
  const target = parseLang(cmd);
  const S = resolveStrings(currentLang);
  if (!target) {
    process.stdout.write(`\n${GRAY}  ${S.lang_current}: ${LANG_NAMES[currentLang] || "English"} (${currentLang})${R}\n`);
    process.stdout.write(`${GRAY}  ${S.lang_available} ${R}${BOLD}lang <code>${R}${GRAY}:${R}\n${DIM}${langListBlock()}${R}\n`);
    return currentLang;
  }
  if (!LANG_NAMES[target]) {
    process.stdout.write(`\n${RED}  ${S.lang_unknown}: ${target}${R}\n`);
    process.stdout.write(`${GRAY}  ${S.lang_available} ${R}${BOLD}lang <code>${R}${GRAY}:${R}\n${DIM}${langListBlock()}${R}\n`);
    return currentLang;
  }
  writeCliPrefs({ ...readCliPrefs(), lang: target });
  const T = resolveStrings(target);
  process.stdout.write(`\n${GRAY}  ${T.lang_set} ${LANG_NAMES[target]} (${target})${R}\n\n`);
  return target;
}

// ── printWelcome — friendly orientation shown once at startup ─────────────────
export function printWelcome({ showExamples = true, lang = "en" } = {}) {
  const S = resolveStrings(lang);
  process.stdout.write(
    `\n  ${BOLD}${CYAN}✦ Aperio${R}  ${GRAY}${S.welcome_tagline}${R}\n` +
    `  ${DIM}${S.welcome_privacy}${R}\n\n`
  );
  if (showExamples) {
    process.stdout.write(
      `  ${GRAY}${S.welcome_intro}${R}\n` +
      `    ${CYAN}•${R} ${S.welcome_ex_summarize}  ${DIM}${S.welcome_ex_summarize_h}${R}\n` +
      `    ${CYAN}•${R} ${S.welcome_ex_plan}\n` +
      `    ${CYAN}•${R} ${S.welcome_ex_explain}  ${DIM}${S.welcome_ex_explain_h}${R}\n\n`
    );
  }
  process.stdout.write(
    `  ${DIM}${S.welcome_help_pre}${R}${BOLD}/help${R}${DIM}${S.welcome_help_post}${R}\n` +
    `  ${DIM}${S.welcome_stop_hint}${R}\n`
  );
}

// ── printHelp — plain-language command guide (path-aware) ─────────────────────
export function printHelp({ proxy = false, showExamples = true, lang = "en" } = {}) {
  const S = resolveStrings(lang);
  const section = (title, rows) => {
    process.stdout.write(`\n  ${BOLD}${title}${R}\n`);
    for (const [cmd, desc, tryExample] of rows) {
      process.stdout.write(`    ${CYAN}${cmd.padEnd(18)}${R}${GRAY}${desc}${R}\n`);
      // try: line is dimmed and aligned under the description so it stays
      // subordinate to the command name (#178). Only when examples are on.
      if (showExamples && tryExample) {
        process.stdout.write(`    ${" ".repeat(18)}${DIM}try:  ${tryExample}${R}\n`);
      }
    }
  };

  process.stdout.write(`\n${BOLD}  ${S.help_title}${R}\n`);
  process.stdout.write(`${GRAY}  ${"─".repeat(60)}${R}\n`);
  process.stdout.write(`  ${GRAY}${S.help_intro}${R}\n`);

  section(S.help_sec_everyday, [
    ["/attach <file>", S.desc_attach,    "/attach ~/Downloads/report.pdf"],
    ["/summarize",     S.desc_summarize, "/summarize"],
    ["remember that…", S.desc_remember,  "remember that I prefer terse answers"],
  ]);
  if (proxy) {
    section(S.help_sec_deeper, [
      ["/discuss on", S.desc_discuss, "/discuss on"],
    ]);
  }
  section(S.help_sec_yours, [
    ["/memories",    S.desc_memories, "/memories"],
    ["/self",        S.desc_self,     "/self"],
    ["/forget <id>", S.desc_forget,   "/forget 3f9a2c"],
    ["/sessions",    S.desc_sessions, "/sessions   →   /resume 1a2b3c"],
    ["/resume <id>", S.desc_resume,   "/resume 3f9a2c"],
    ["/handoff",     S.desc_handoff,  "/handoff"],
  ]);
  section(S.help_sec_display, [
    ["/examples",  S.desc_examples],
    ["/lang",      S.desc_lang],
    ["/restart",   S.desc_restart],
    ["/reasoning", S.desc_reasoning],
    ["/stats",     S.desc_stats],
    ["/status",    S.desc_status],
    ["/config",    S.desc_config],
    ["/clear",     S.desc_clear],
    ["/exit",      S.desc_exit],
  ]);
  if (showExamples) {
    process.stdout.write(`\n  ${DIM}${S.help_tip_pre}${R}${BOLD}/examples${R}${DIM}${S.help_tip_mid}${R}${BOLD}/help <command>${R}${DIM}${S.help_tip_post}${R}\n`);
  }
  process.stdout.write("\n");
}

// ── help <command> — focused per-command docs (#178 Phase 3) ─────────────────
// `title` is command syntax (never translated); `bodyKey` points at the
// localizable prose in strings.js; `examples` are runnable, language-neutral.
// Keys here must match commands.js HELP_TARGETS (enforced by a unit test).
export const HELP_DETAILS = {
  attach:    { title: "/attach <file>",    bodyKey: "detail_attach",    examples: ["/attach ~/Downloads/report.pdf", "/attach ./notes.md"] },
  summarize: { title: "/summarize",        bodyKey: "detail_summarize", examples: ["/summarize"] },
  remember:  { title: "remember that …",   bodyKey: "detail_remember",  examples: ["remember that I prefer terse answers", "remember that my timezone is CET"] },
  memories:  { title: "/memories",         bodyKey: "detail_memories",  examples: ["/memories", "/memories   →   /forget 3f9a2c"] },
  forget:    { title: "/forget <id>",      bodyKey: "detail_forget",    examples: ["/forget 3f9a2c"] },
  sessions:  { title: "/sessions",         bodyKey: "detail_sessions",  examples: ["/sessions", "/sessions   →   /resume 1a2b3c"] },
  resume:    { title: "/resume <id>",      bodyKey: "detail_resume",    examples: ["/resume 1a2b3c"] },
  handoff:   { title: "/handoff",          bodyKey: "detail_handoff",   examples: ["/handoff", "/handoff focus on the open bugs"] },
  discuss:   { title: "/discuss on / off", bodyKey: "detail_discuss",   examples: ["/discuss on", "/discuss off"] },
  examples:  { title: "/examples",         bodyKey: "detail_examples",  examples: ["/examples"] },
  lang:      { title: "/lang <code>",      bodyKey: "detail_lang",      examples: ["/lang", "/lang de", "/lang fr"] },
  restart:   { title: "/restart [--hard]", bodyKey: "detail_restart",   examples: ["/restart", "/restart --hard"] },
  reasoning: { title: "/reasoning",        bodyKey: "detail_reasoning", examples: ["/reasoning"] },
  stats:     { title: "/stats",            bodyKey: "detail_stats",     examples: ["/stats"] },
  status:    { title: "/status",           bodyKey: "detail_status",    examples: ["/status"] },
  config:    { title: "/config",           bodyKey: "detail_config",    examples: ["/config"] },
};

export function printHelpFor(target, { proxy = false, lang = "en" } = {}) {
  const S = resolveStrings(lang);
  const d = HELP_DETAILS[target];
  if (!d) {
    process.stdout.write(`\n${GRAY}  No specific help for "${target}". Here's everything:${R}\n`);
    printHelp({ proxy, showExamples: true, lang });
    return;
  }
  process.stdout.write(`\n  ${BOLD}${d.title}${R}\n`);
  process.stdout.write(`${GRAY}  ${"─".repeat(60)}${R}\n`);
  process.stdout.write(`  ${GRAY}${S[d.bodyKey]}${R}\n`);
  for (const ex of d.examples) {
    process.stdout.write(`    ${DIM}try:  ${ex}${R}\n`);
  }
  process.stdout.write("\n");
}

// ── printStatus — full technical panel on demand ─────────────────────────────
// The compact navbar (reprinted above each prompt) carries the glance —
// model/mode/docker/storage — so `status` earns its place by being the superset:
// it adds the session toggles (language, reasoning, stats, examples) the strip omits.
export function printStatus({ reasoning, stats, examples, lang } = {}) {
  const { mode, model, dockerOn, db } = getHeaderInfo();
  const onOff = (v) => (v ? `${GREEN}on${R}` : `${GRAY}off${R}`);
  const row = (label, val) => `  ${GRAY}${label.padEnd(10)}${R}${val}\n`;

  let out = `\n${BOLD}  Status${R}\n${GRAY}  ${"─".repeat(40)}${R}\n`;
  out += row("mode", mode);
  out += row("model", model);
  out += row("docker", dockerOn ? `${GREEN}on${R}` : `${GRAY}off${R}`);
  out += row("storage", db);
  if (lang !== undefined)      out += row("language", `${LANG_NAMES[lang] || "English"} (${lang})`);
  if (reasoning !== undefined) out += row("reasoning", onOff(reasoning));
  if (stats !== undefined)     out += row("stats", onOff(stats));
  if (examples !== undefined)  out += row("examples", onOff(examples));
  out += "\n";
  process.stdout.write(out);
}

// ── printConfig — effective config values + their source (#182) ───────────────
// Standalone reads process.env + the boot provenance snapshot (applyConfigToEnv
// ran during startup). Proxy fetches the running server's /api/config/schema,
// which is the authority there since the CLI process never applied DB config.
// Focused on the vars behind the reported confusion; the full registry lives in
// the web Config panel.
export async function printConfig({ port } = {}) {
  const SRC = { db: "from UI", env: "from .env", default: "default" };
  let get;                 // (key) => { value, label }
  let warnings = [];
  let precedence = process.env.APERIO_CONFIG_PRECEDENCE || "db";

  if (port) {
    try {
      const schema = await fetch(`http://localhost:${port}/api/config/schema`).then((r) => r.json());
      const byKey = new Map((schema.fields || []).map((f) => [f.key, f]));
      get = (k) => { const f = byKey.get(k); return { value: f ? f.value : process.env[k], label: f ? SRC[f.source] : null }; };
      warnings = (schema.warnings || []).map((w) => w.message);
      if (schema.precedence) precedence = schema.precedence;
    } catch { /* server unreachable — fall back to the local view */ }
  }
  if (!get) {
    get = (k) => ({ value: process.env[k], label: configSourceLabel(k) });
    const provider = (process.env.AI_PROVIDER || "").toLowerCase();
    const llamacppCtx = llamacppCtxStatus();
    if (provider === "llamacpp" && llamacppCtx.mismatch) {
      warnings = [`LLAMACPP_CTX (${llamacppCtx.assumed}) exceeds LLAMACPP_SERVE_CTX (${llamacppCtx.real}); ` +
        `clamped to ${llamacppCtx.real}. Raise LLAMACPP_SERVE_CTX or lower LLAMACPP_CTX.`];
    }
  }

  const row = (label, key, fallback = "(unset)") => {
    const { value, label: src } = get(key);
    const v = (value == null || value === "") ? fallback : value;
    return `  ${GRAY}${label.padEnd(22)}${R}${v}${src ? ` ${DIM}(${src})${R}` : ""}\n`;
  };

  const provider = (get("AI_PROVIDER").value || process.env.AI_PROVIDER || "").toLowerCase();

  let out = `\n${BOLD}  Config${R}\n${GRAY}  ${"─".repeat(52)}${R}\n`;
  out += `  ${GRAY}${"precedence".padEnd(22)}${R}${precedence}\n`;
  out += row("AI_PROVIDER", "AI_PROVIDER", "(not configured — pick one in Settings)");
  if (provider === "llamacpp") {
    out += row("LLAMACPP_MODEL", "LLAMACPP_MODEL", "Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M");
    out += row("LLAMACPP_CTX", "LLAMACPP_CTX", "32768");
    out += row("LLAMACPP_SERVE_CTX", "LLAMACPP_SERVE_CTX");
  }
  for (const w of warnings) out += `\n  ${YELLOW}⚠ ${w}${R}\n`;
  out += "\n";
  process.stdout.write(out);
}

// ── printSessions — shared by both proxy and standalone ───────────────────────
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function printSessions() {
  initSessions(ROOT);
  const all = listSessions();
  if (!all.length) {
    process.stdout.write(`\n${GRAY}  no sessions found${R}\n\n`);
    return;
  }
  const shown = all.slice(0, 15);
  process.stdout.write(`\n${BOLD}  Recent sessions${R}\n`);
  process.stdout.write(`${GRAY}  ${"─".repeat(72)}${R}\n`);
  for (const s of shown) {
    const date  = new Date(s.startedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    const model = s.model ? ` ${GRAY}${s.provider}/${s.model}${R}` : "";
    const title = (s.title ?? "Untitled").slice(0, 44).padEnd(44);
    process.stdout.write(`  ${DIM}${s.id.slice(0, 8)}${R}  ${title}  ${GRAY}${date}${R}${model}\n`);
  }
  if (all.length > 15) process.stdout.write(`${GRAY}  … and ${all.length - 15} more${R}\n`);
  process.stdout.write(`\n${DIM}  Use: /resume <id>${R}\n\n`);
}
