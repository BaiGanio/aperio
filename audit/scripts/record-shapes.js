// audit/scripts/record-shapes.js
//
// The record-shape vocabulary that more than one audit gate depends on. It
// lives here, rather than being copied into each module, for the same reason
// schema.js owns the single lifecycle graph: when two gates ask "is this field
// a real answer?" they must be asking the same question.
//
// comparableText is the one that would actually hurt if it drifted. T6's
// confirmation gate uses it to decide whether a finding's `expected` and
// `actual` describe two different behaviors, and T8.3's regression-test gate
// uses it to decide whether a promised assertion design is more than the
// finding's own title pasted back. Two spellings of that rule means a finding
// could clear one gate and silently fail the other's intent.
//
// RUNNABLE_COMMAND is shared for a sharper reason. T6 reads it as "this
// reproduction is something a human can re-run"; T8.2 reads it as "this line is
// a payload that must never reach a public issue". They are the same sentence
// seen from two sides, so a command form that only one list knows is exactly a
// reproduction T6 accepts as evidence and T8.2 then fails to recognize on its
// way out the door.

/**
 * A whitespace-only string ("   ") is content-free the same way "" is: it must
 * not satisfy a required-field, evidence-detail, deferral, or approver check
 * just because it has a nonzero .length.
 */
export function isBlank(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

/**
 * The positive form of isBlank: a value that is genuinely a non-empty string.
 * `{}` and `[]` are NOT blank (they are malformed), so anywhere a record must
 * carry human-readable content, this is the check — not !isBlank().
 */
export function isNonBlankString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * One spelling per sentence, for the places where two record fields have to say
 * DIFFERENT things. Surrounding and repeated whitespace and letter case are
 * presentation; they never make two descriptions of behavior distinguishable.
 */
export function comparableText(value) {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The runners a reproduction or an exploit is typed with. Kept as a list rather
 * than spelled inside the regex because T8.2 needs the same vocabulary in a
 * form it can test ONE token against: its summary scanner looks for a command
 * sitting inside a sentence, where nothing is anchored to the start of a line.
 * Two copies of this list is exactly the drift the module header warns about —
 * a runner one gate knows and the other does not is a command that clears the
 * evidence gate and is then unrecognized on its way out to the public.
 *
 * The second group is here because an allowlist built from THIS repository's
 * build tools answers the wrong question at the disclosure gate. `rm -rf /data`,
 * `nc host 4444`, and `kubectl delete …` are the commands a security finding is
 * actually about, they are short enough to clear every length rule, and none of
 * them runs anything this project builds with — so a list of package managers
 * and interpreters skipped exactly the lines that must never be published.
 *
 * Both gates read the longer list, deliberately. T6 gains only that `rm -rf …`
 * counts as a re-runnable reproduction, which it is; T8.2 gains the refusal.
 * The alternative — a private superset inside triage.js — is the same drift in
 * the opposite direction, and the direction is not what makes it a hazard.
 */
/**
 * The Windows half of the runner list, kept separately because Windows command
 * names are case-INSENSITIVE and their documented spellings carry capitals.
 *
 * A findings ledger that only knows POSIX runners reads a Windows exploit as
 * prose: `PowerShell -EncodedCommand …` carries its whole payload in one base64
 * argument, which is short, punctuation-free once decoded, and matches nothing
 * else in this module. The living-off-the-land binaries here are listed for the
 * same reason — each one is a documented way to fetch and run code, and, unlike
 * `make` or `node`, none of them is a word. That last part is what makes it safe
 * to match them in any case: there is no English sentence for a capital to
 * belong to.
 */
export const WINDOWS_RUNNERS = [
  "powershell", "pwsh", "cmd", "wscript", "cscript", "certutil", "rundll32",
  "mshta", "bitsadmin", "msiexec", "regsvr32", "schtasks", "wmic", "netsh",
  "icacls", "takeown",
];

export const COMMAND_RUNNERS = [
  // interpreters, package managers, and the tools this project builds with
  "npm", "npx", "pnpm", "yarn", "node", "bash", "sh", "zsh", "git", "docker",
  "curl", "wget", "make", "psql", "sqlite3", "python3", "python",
  "perl", "ruby", "php", "java",
  // destructive filesystem and permission changes. `cp` is here with `mv`
  // because a COPY is the whole exfiltration: `cp /etc/passwd /tmp/leak` moves
  // the file somewhere readable without disturbing the original, which is the
  // quieter half of the same act.
  "rm", "cp", "mv", "dd", "shred", "mkfs", "chmod", "chown", "chgrp",
  // network reach, exfiltration, and reconnaissance
  "nc", "netcat", "socat", "telnet", "ssh", "scp", "sftp", "rsync", "ftp",
  "tcpdump", "nmap", "iptables",
  // credential and payload handling
  "openssl", "gpg", "keytool", "xxd", "base64",
  // reading a file straight out, and packing one up to leave. `cat /etc/passwd`
  // is the plainest exfiltration line there is, and it was invisible here: the
  // chaining rules recognized `cat` only AFTER a `;` or a `|`, so the summary
  // that simply said "Run cat /etc/passwd to retrieve the file" exported. `head`,
  // `tail`, `less`, `more`, `find`, `sort`, and `type` are deliberately absent —
  // each is ordinary English in exactly the slot a summary uses it.
  "cat", "tac", "zcat", "awk", "sed", "tar", "unzip", "gzip",
  // data stores, where a dump is the whole exploit
  "mysql", "mongo", "mongosh", "mongodump", "pg_dump", "redis-cli",
  // orchestration and cloud control planes
  "kubectl", "helm", "terraform", "aws", "gcloud", "az",
  // service control and privilege
  "systemctl", "launchctl", "killall", "pkill", "sudo", "doas", "su",
  "useradd", "usermod", "chpasswd", "crontab",
  ...WINDOWS_RUNNERS,
];

/**
 * The subset of COMMAND_RUNNERS that is never an English word.
 *
 * `make`, `curl`, `node`, and `service` appear in honest prose constantly, so a
 * summary containing one is only a command when an ARGUMENT follows in the very
 * next slot. `rm`, `nc`, `kubectl`, and `chmod` carry no such second life: they
 * appear in a sentence only because someone is quoting a command. That buys a
 * slightly wider read — `nc host 4444` puts its port two tokens out, past where
 * a prose-safe rule may look — without buying the false positives, because the
 * words that would trip it do not occur.
 *
 * `service`, `kill`, `strings`, `go`, and `base64` are DELIBERATELY absent from
 * this set (`base64` is a runner, but "a base64 payload" is ordinary writing),
 * and `go`, `kill`, `net`, `reg`, and `service` are absent from the runner list
 * altogether: each is common enough as English — or as an abbreviation prose
 * uses — that recognizing it as a command would refuse the summaries this gate
 * exists to publish.
 */
export const NEVER_PROSE_RUNNERS = new Set([
  "rm", "cp", "mv", "dd", "shred", "mkfs", "chmod", "chown", "chgrp",
  "nc", "netcat", "socat", "telnet", "scp", "sftp", "rsync", "tcpdump", "nmap",
  "iptables", "openssl", "gpg", "keytool", "xxd",
  "mongosh", "mongodump", "pg_dump", "redis-cli",
  "kubectl", "helm", "terraform", "gcloud",
  "systemctl", "launchctl", "killall", "pkill", "sudo", "doas", "su",
  "useradd", "usermod", "chpasswd", "crontab",
  "powershell", "pwsh", "cmd", "wscript", "cscript", "certutil", "rundll32",
  "mshta", "bitsadmin", "msiexec", "regsvr32", "schtasks", "wmic", "netsh",
  "icacls", "takeown",
]);

/**
 * A line that begins with a runner someone can actually type. Used by T6 to
 * accept a reproduction as re-runnable and by T8.2 to refuse the same line
 * inside a sanitized public summary.
 *
 * Case-insensitive for the WINDOWS runners only, and case-sensitive for the
 * rest. `PowerShell -EncodedCommand ...`, `CMD /c ...`, and `CertUtil -urlcache
 * ...` are the spellings those tools are documented and typed with, and each one
 * runs exactly as written, so a case-sensitive match reads all three as prose —
 * T6 refuses a real reproduction and T8.2 lets the same payload out.
 *
 * The blanket `i` flag that would fix that costs more than it buys, because the
 * POSIX half is full of English words. `Make sure the invariant is checked` and
 * `Node providers can retry` are how required fields are ordinarily written, and
 * a sentence's opening capital is exactly what turns them into "a command" — so
 * T6 would accept prose as a reproduction, which is the same empty promise this
 * module exists to refuse, arriving from the other direction. Every Windows name
 * here is a binary and never a word, so widening only those alternatives has no
 * sentence to collide with.
 */
const anyCase = (word) => Array.from(word)
  .map((ch) => (/[a-z]/.test(ch) ? `[${ch}${ch.toUpperCase()}]` : ch))
  .join("");

const RUNNER_ALTERNATIVES = COMMAND_RUNNERS
  .map((runner) => (WINDOWS_RUNNERS.includes(runner) ? anyCase(runner) : runner));

/**
 * The directory an executable is invoked THROUGH, and the suffix it carries on
 * Windows. `/bin/sh -c whoami`, `C:\Windows\System32\cmd.exe /c ...`, and
 * `./exploit.sh` all run exactly as written, and none of them puts a bare
 * runner where a name-only rule looks — so the runner has to be read after the
 * path is taken off, or the most explicit spelling of a command is the one that
 * publishes.
 *
 * The prefix must BEGIN like a path — `/`, `./`, `../`, `~/`, or a drive
 * letter — and that requirement is what keeps prose out. `audit/scripts/git`
 * and `and/or make` are the shapes a relative-looking prefix would swallow;
 * neither starts a path, so neither reaches the runner list.
 */
const EXECUTABLE_DIRECTORY = String.raw`(?:[A-Za-z]:)?(?:[\\/]|(?:\.{1,2}|~)[\\/])(?:[\w.+-]+[\\/])*`;
const EXECUTABLE_SUFFIXES = ["exe", "com", "bat", "cmd", "ps1"];
const EXECUTABLE_SUFFIX = String.raw`\.(?:${EXECUTABLE_SUFFIXES.map(anyCase).join("|")})`;

const EXECUTABLE_PATH = new RegExp(String.raw`^(?:${EXECUTABLE_DIRECTORY})([\w.+-]+)$`);
const TRAILING_SUFFIX = new RegExp(String.raw`(?:${EXECUTABLE_SUFFIX})$`);

/**
 * The executable a token names, with the directory and the Windows suffix taken
 * off: `/bin/sh` and `powershell.exe` are `sh` and `powershell`.
 *
 * A token this function CHANGED is an executable and never an English word — no
 * sentence spells a word with a directory in front of it — which is what lets
 * the caller drop the case rules that exist only to protect prose.
 *
 * A token with no path is returned as it came, so an ordinary word is compared
 * exactly as before.
 */
export function executableName(token) {
  const text = String(token).trim();
  const withoutDirectory = EXECUTABLE_PATH.exec(text)?.[1] ?? text;
  return withoutDirectory.replace(TRAILING_SUFFIX, "");
}

/**
 * Executables that are a whole command with NO argument at all.
 *
 * `whoami`, `tcpdump`, and `poweroff` print the current user, start capturing
 * every packet on the wire, and drop the machine — each one complete the moment
 * it is named. Every rule that waits for an operand therefore reads them as
 * words, and they are not: none of these spellings is English, so naming one in
 * a summary is already quoting it.
 *
 * `id`, `env`, `history`, `mount`, `w`, and `last` are DELIBERATELY absent, even
 * though each is a real no-argument command: every one of them is an ordinary
 * English word that a sanitized summary uses in exactly this slot, and a gate
 * that blocks honest writing is a gate that gets switched off.
 */
export const NO_ARGUMENT_BINARIES = new Set([
  "whoami", "tcpdump", "poweroff", "mongosh", "redis-cli",
  "uname", "printenv", "dmesg", "ifconfig", "ipconfig", "netstat", "lsof",
  "pwd", "lsblk", "arp", "route",
]);

/**
 * A script or binary invoked THROUGH its path, whatever it is called.
 *
 * `./exploit.sh --target victim` and `/tmp/poc.exe` are commands by
 * construction: the path says "run this file", and no allowlist of runner names
 * will ever contain the attacker's own filename. Two tiers, because two kinds of
 * suffix carry different collision risk:
 *
 *   SHELL — `.sh`, `.ps1`, `.exe`, `.bin`. A file nobody opens for any reason
 *     except to run it, so the path plus an argument is the whole answer.
 *   SOURCE — `.py`, `.rb`, `.js`, `.jar`. These are ALSO the files a summary
 *     names while describing where a defect lives ("the fix lands in
 *     ./lib/routes/paths.js and ships next week"), so one of them counts only
 *     when it is carrying real shell syntax: a flag, a URL, a query.
 */
const SHELL_EXECUTABLE_SUFFIXES = ["sh", "bash", "zsh", "ps1", "exe", "com", "bat", "cmd", "bin", "out", "elf", "run"];
const SOURCE_EXECUTABLE_SUFFIXES = ["py", "rb", "pl", "php", "js", "mjs", "cjs", "ts", "jar", "scpt", "vbs"];
const suffixAlternatives = (list) => String.raw`\.(?:${list.map(anyCase).join("|")})`;
const SHELL_EXECUTABLE = suffixAlternatives(SHELL_EXECUTABLE_SUFFIXES);
const ANY_EXECUTABLE = suffixAlternatives([...SHELL_EXECUTABLE_SUFFIXES, ...SOURCE_EXECUTABLE_SUFFIXES]);
const SHELL_ARGUMENT = String.raw`-{1,2}[A-Za-z0-9]|\S*(?::\/\/|[=&?|])`;

/**
 * A path-qualified file that is being RUN, for the summary scanner's walk.
 *
 * Two of them, and the difference is the same one the tiers above draw: a
 * SHELL executable is a command on the strength of its name alone, while a
 * source file still has to be carrying an argument, because naming one is how a
 * summary says where the defect lives.
 */
export const PATH_QUALIFIED_EXECUTABLE =
  new RegExp(String.raw`^(?:${EXECUTABLE_DIRECTORY})[\w.+-]*(?:${ANY_EXECUTABLE})$`);
export const PATH_QUALIFIED_SHELL_EXECUTABLE =
  new RegExp(String.raw`^(?:${EXECUTABLE_DIRECTORY})[\w.+-]*(?:${SHELL_EXECUTABLE})$`);

export const RUNNABLE_COMMAND = new RegExp("^(?:" + [
  // a runner this module knows by name, with or without its path
  String.raw`(?:${EXECUTABLE_DIRECTORY})?(?:${RUNNER_ALTERNATIVES.join("|")})(?:${EXECUTABLE_SUFFIX})?\s+\S`,
  // a path-qualified file nobody opens except to run it, argument or not:
  // `/tmp/poc.exe` on its own line is already the whole reproduction
  String.raw`(?:${EXECUTABLE_DIRECTORY})[\w.+-]*(?:${SHELL_EXECUTABLE})(?:\s+\S|$)`,
  // a path-qualified source file, but only while it carries shell syntax
  String.raw`(?:${EXECUTABLE_DIRECTORY})[\w.+-]*(?:${ANY_EXECUTABLE})\s+(?:${SHELL_ARGUMENT})`,
  // a command that is finished the moment it is named
  String.raw`(?:${EXECUTABLE_DIRECTORY})?(?:${[...NO_ARGUMENT_BINARIES].join("|")})(?:${EXECUTABLE_SUFFIX})?$`,
].join("|") + ")");

/**
 * The command inside a line that was WRITTEN for a reader rather than for a
 * shell. A reproduction is copied out of a terminal or a markdown file, so the
 * runner is routinely not at column zero:
 *
 *   $ curl -X POST https://host/vulnerable
 *   > npm run seed
 *   - `docker exec -it db psql`
 *   ```bash
 *
 * RUNNABLE_COMMAND is anchored, so every one of those forms reads as "not a
 * command" — which is harmless when the answer only decides whether evidence
 * counts, and is a disclosure hole when it decides whether an exploit-ready
 * line may be published. Decoration is presentation; the command underneath is
 * the thing that runs, so it is what both gates must see.
 *
 * The loop re-applies the strips because the forms nest (`- $ curl ...`), and
 * stops as soon as a pass changes nothing.
 */
export function commandInLine(line) {
  let text = String(line).trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const before = text;
    text = text
      // markdown list marker: a bullet, or the number of an ORDERED step, which
      // is how a reproduction with more than one command is always written
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      // an opening code fence, whose language tag is not part of the command
      .replace(/^```[A-Za-z0-9_-]*\s*/, "")
      // an inline-code tick, which is followed by the command ITSELF — so
      // nothing after it may be consumed as a language tag
      .replace(/^`{1,2}/, "")
      .replace(/`{1,3}$/, "")
      // a shell prompt, with or without the user@host or path that precedes it
      .replace(/^(?:[^\s$#%>]*[$#%>]|[$#%>])\s+/, "")
      .trim();
    if (text === before) break;
  }
  return text;
}
