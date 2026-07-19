#!/usr/bin/env bash
# ============================================================
# install.sh — Aperio one-liner installer (for technical users)
#
#   curl -fsSL https://raw.githubusercontent.com/BaiGanio/aperio/release/.github/lite/install.sh | bash
#
# Clones the curated `release` branch into ~/aperio (override with APERIO_HOME)
# and hands off to START.sh, which installs Node + dependencies and starts the
# app — opening the browser setup wizard. Re-running UPDATES in place
# (fast-forward to origin/release); your memory DB (var/ and .sqlite/) is
# git-ignored, so it is preserved across updates. This is the one install flow
# that updates without a re-download; the zip is the click-nothing alternative.
# Maintained automation may set APERIO_INSTALL_NO_START=1 to verify the real
# clone/update path without handing control to the long-running app process.
# ============================================================
set -uo pipefail

REPO_URL="${APERIO_REPO_URL:-https://github.com/BaiGanio/aperio.git}"
BRANCH="${APERIO_BRANCH:-release}"
DIR="${APERIO_HOME:-$HOME/aperio}"

# ── minimal UI (colours only when stderr is a terminal) ──
if [ -t 2 ]; then
  R=$'\033[0m'; B=$'\033[1m'; D=$'\033[2m'; CY=$'\033[96m'; GR=$'\033[92m'; RD=$'\033[91m'
else R=''; B=''; D=''; CY=''; GR=''; RD=''; fi
ok()   { printf "  ${GR}${B}✔${R}  %s\n" "$*"; }
info() { printf "  ${CY}●${R}  %s\n" "$*"; }
die()  { printf "\n  ${RD}${B}✖  %s${R}\n\n" "$*" >&2; exit 1; }

# Prompts must read the terminal — under `curl … | bash`, stdin is the pipe.
ask() {
  local prompt="$1" ans=""
  if [ "${APERIO_INSTALL_NO_START:-}" = "1" ]; then
    printf '%s' "$ans"
    return
  fi
  [ -r /dev/tty ] && read -r -p "$prompt" ans </dev/tty || true
  printf '%s' "$ans"
}

printf "\n  ${B}${CY}Aperio${R} ${D}· one-liner install${R}\n\n"

command -v git >/dev/null 2>&1 || die "git is required — install it, then re-run."

if [ -e "$DIR" ]; then
  if [ -d "$DIR/.git" ] && git -C "$DIR" remote get-url origin 2>/dev/null | grep -qi 'aperio'; then
    info "Existing Aperio install at $DIR"
    case "$(ask "  Update it to the latest release? [Y/n] ")" in
      [Nn]*) die "Left your install untouched." ;;
    esac
    info "Updating…"
    git -C "$DIR" fetch --depth 1 origin "$BRANCH" >/dev/null 2>&1 || die "Could not fetch updates."
    git -C "$DIR" reset --hard FETCH_HEAD          >/dev/null 2>&1 || die "Could not apply updates."
    ok  "Updated (your data in var/ and .sqlite/ is untouched)."
  else
    die "$DIR already exists and is not an Aperio install.
     Remove it, or choose another location:  APERIO_HOME=/path curl … | bash"
  fi
else
  info "Installing Aperio into $DIR"
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$DIR" >/dev/null 2>&1 \
    || die "Clone of the '$BRANCH' branch failed (is it published yet?)."
  ok "Cloned the $BRANCH branch."
fi

cd "$DIR" || die "Could not enter $DIR."

# Launchers live in .github/lite/ in the repo, but the app runs from the root
# (alongside package.json / node_modules) — mirror them up, exactly as the
# release zip does, so START.sh finds package.json where it expects it.
cp .github/lite/START.sh .github/lite/START.bat .github/lite/launch-hidden.sh \
   .github/lite/uninstall.sh .github/lite/uninstall.bat . 2>/dev/null || true
cp -r .github/lite/assets . 2>/dev/null || true
chmod +x START.sh launch-hidden.sh uninstall.sh 2>/dev/null || true

if [ "${APERIO_INSTALL_NO_START:-}" = "1" ]; then
  ok "Installed without launching (automation mode)."
elif [ -r /dev/tty ]; then
  printf "\n  ${GR}${B}✔  Starting Aperio…${R}  ${D}(Node + deps install on first run)${R}\n\n"
  exec bash START.sh
else
  ok "Installed. Start it with:  cd \"$DIR\" && bash START.sh"
fi
