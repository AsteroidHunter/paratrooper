#!/usr/bin/env bash
# install.sh - set up Paratrooper on Render and link it to your phone.
#
# Run from the cloned repo:
#   ./install.sh
#
# What it does, in order:
#   0. Prepares an isolated local environment with the project and its
#      dependencies, so a fresh clone works and nothing lands in global Python
#      (built once, reused after).
#   1. Signs you in to Render (opens the browser; the CLI saves the session).
#   2. Signs you in to Claude Code and mints a worker token with
#      claude setup-token. Claude Code itself is a prerequisite.
#   3. Offers idle sleeping: the web service can suspend the worker when the
#      queue is empty to cut the Render bill. Skip it and the worker stays on,
#      and no key is needed for that feature.
#   4. Checks for an existing app, then either confirms keeping its password or
#      asks for a long passphrase twice with hidden input.
#   Then, with no more questions:
#   5. Writes a plain deployment config, generates the
#      browser-notification (VAPID) keys, and validates the config and the
#      blueprint before touching Render.
#   6. Creates the Key Value store, the worker and the web service on Render from
#      render.yaml, wiring their links, secrets and notification keys, and waits
#      for the app to answer.
#   Finally: prints the app address and the phone Home Screen and
#   notification steps. A deployment that was created but has not answered its
#   health check yet is reported as such and exits non-zero, without removing
#   anything.
#
# Scope note. This is a first install: it builds the deployment render.yaml
# describes. Render has no API that applies a whole blueprint, so the helper
# `python -m paratrooper.provision` creates each resource through the documented
# REST API and wires the links a blueprint would (REDIS_URL from the Key Value's
# connection string, the worker id into the web service, and the generated VAPID
# keys onto the web service). It is idempotent: a resource that already exists is
# reused only once it is confirmed to be this deployment's own, so a run that
# stopped halfway is finished by running again, preserving the password and
# notification keys already on the service. Changing
# the configuration later is `python -m paratrooper.deploy push`, the project's
# own tool.

# Disable inherited tracing, verbose input and auto-export before collecting any
# secret, even when invoked with bash -x/-v/-a. Never re-enable them in this script.
set +xv
set +a
set -euo pipefail

LOG="$HOME/.paratrooper-install.log"
: > "$LOG"
REPO="$(cd "$(dirname "$0")" && pwd)"

# A per-user cache for the things this installer obtains, all outside the clone
# and outside the global Python, so nothing lands in source control or changes a
# system install.
CACHE="$HOME/.cache/paratrooper"
# The isolated environment the project's laptop tools run in, and its Python.
# Built in preflight so a fresh clone works; reused if already present.
VENVDIR="${PARATROOPER_INSTALL_VENV:-$CACHE/venv}"
PY="$VENVDIR/bin/python"
# The interpreter used to build the venv: an existing python3 (>= 3.12) if there
# is one, otherwise a standalone Python obtained into the cache. Set by
# ensure_python before the venv is built.
PY_BOOT="python3"
# Air-gapped installs point this at a directory holding the dependencies, so the
# environment is built without the network. Empty means fetch them normally.
OFFLINE_DEPS="${PARATROOPER_INSTALL_OFFLINE_DEPS:-}"

# What this script generates and reads. The config file is git ignored, and it
# never holds a secret: tokens and keys are environment variables on the
# services, set at creation and never written to disk here.
CONFIG_FILE="$REPO/config/paratrooper.toml"
BLUEPRINT="$REPO/render.yaml"
HEALTH_PATH="/api/health"

# Where Render builds from. The provisioner needs the repository URL and branch
# to create the two Docker services; they come from this clone's own `origin`
# remote unless overridden (the overrides are what the offline tests use, so no
# git call is made there). No repository question is asked: this is the clone the
# user already ran the script from.
REPO_URL="${PARATROOPER_INSTALL_REPO_URL:-}"
REPO_BRANCH="${PARATROOPER_INSTALL_BRANCH:-}"

# The provisioner writes a small JSON report here (ids, the web address, whether
# each resource was created). It carries no secret and is removed on exit.
REPORT_FILE=""
TERMINAL_STATE=""
PASSWORD_MODE=""
EXISTING_WEB_ID=""

# Secrets live only in these shell variables, for the life of this process. They
# are never written to the log, never echoed back, and never named in an error.
# Remove inherited export attributes, so input cannot become a child process's
# environment if the caller happened to export variables with these names.
unset CLAUDE_TOKEN APP_PASSWORD RENDER_KEY provision_payload
CLAUDE_TOKEN=""
APP_PASSWORD=""
RENDER_KEY=""
IDLE_SLEEP="no"

# --- helpers ---------------------------------------------------------------

err() { printf '%s\n' "$*" >&2; }

# cleanup - restore the terminal and remove the non-secret report on the way out.
cleanup() {
	if [ -n "$TERMINAL_STATE" ]; then
		stty "$TERMINAL_STATE" 2>/dev/null || true
	fi
	[ -n "$REPORT_FILE" ] && rm -f "$REPORT_FILE" 2>/dev/null
	unset APP_PASSWORD CLAUDE_TOKEN RENDER_KEY provision_payload
	return 0
}
trap cleanup EXIT
trap 'err ""; err "Installation canceled. Run ./install.sh again when ready."; exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# --- presentation helpers --------------------------------------------------
# ANSI color only when stdout is a TTY (keeps logs/redirects clean).

if [ -t 1 ]; then
	BOLD=$'\033[1m'
	DIM=$'\033[2m'
	GREEN=$'\033[38;2;0;114;0m'
	RESET=$'\033[0m'
else
	BOLD='' DIM='' GREEN='' RESET=''
fi

# Per-phase spinner frame sets, reassigned at the start of each phase that uses
# the spinner, e.g. SPIN_FRAMES=("${SPIN_HEAVY[@]}").
SPIN_HEAVY=(⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷)
SPIN_CIRCLE=(◐ ◓ ◑ ◒)
SPIN_CLASSIC=('|' '/' '-' '\')
SPIN_FRAMES=("${SPIN_HEAVY[@]}")

# banner <subtitle> - print the gradient PARATROOPER wordmark followed by a
# right-aligned subtitle. The wordmark is drawn in inline python3 because
# UTF-8-aware per-char coloring in bash is awkward (each block is 3 bytes).
# Brand-green #007200 on the left fades to (180, 240, 180) on the right.
banner() {
	local subtitle="${1:-}"
	# The wordmark is drawn with python3. This runs before the runtime is ensured,
	# so if there is no python3 yet, fall back to a plain title rather than fail.
	if ! command -v python3 >/dev/null 2>&1; then
		printf '%sPARATROOPER%s\n' "$BOLD" "$RESET"
		[ -n "$subtitle" ] && printf '%s\n' "$subtitle"
		return 0
	fi
	local use_color=0
	[ -t 1 ] && use_color=1
	python3 - "$subtitle" "$use_color" <<'PY'
import sys
subtitle = sys.argv[1] if len(sys.argv) > 1 else ""
use_color = (sys.argv[2] == "1") if len(sys.argv) > 2 else False
# A compact five-row block face. Eleven letters in a heavier face would run past
# eighty columns and wrap; this keeps the wordmark on one line on a plain
# terminal while staying a wordmark.
GLYPHS = {
    "P": ["█████", "█   █", "█████", "█    ", "█    "],
    "A": ["█████", "█   █", "█████", "█   █", "█   █"],
    "R": ["█████", "█   █", "█████", "█  █ ", "█   █"],
    "T": ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
    "O": ["█████", "█   █", "█   █", "█   █", "█████"],
    "E": ["█████", "█    ", "████ ", "█    ", "█████"],
    " ": ["     ", "     ", "     ", "     ", "     "],
}
WORD = "PARATROOPER"
ROWS = [" ".join(GLYPHS[ch][r] for ch in WORD) for r in range(5)]
START = (0, 114, 0)
END = (180, 240, 180)
width = max(len(r) for r in ROWS)
for row in ROWS:
    out = []
    for i, ch in enumerate(row):
        if ch == " " or not use_color:
            out.append(ch)
            continue
        t = i / max(width - 1, 1)
        r = int(START[0] + t * (END[0] - START[0]))
        g = int(START[1] + t * (END[1] - START[1]))
        b = int(START[2] + t * (END[2] - START[2]))
        out.append(f"\x1b[38;2;{r};{g};{b}m{ch}")
    if use_color:
        out.append("\x1b[0m")
    print("".join(out))
if subtitle:
    pad = max(width - len(subtitle), 0)
    print(" " * pad + subtitle)
PY
}

# section <title> - print a bold numbered header followed by a `─` underline
# matching the title's character length, then a blank line.
section() {
	local title="$1"
	printf '\n%s%s%s\n' "$BOLD" "$title" "$RESET"
	local len=${#title} i=0 underline=""
	while [ "$i" -lt "$len" ]; do
		underline="${underline}─"
		i=$((i+1))
	done
	printf '%s\n\n' "$underline"
}

# spinner <running-msg> <success-msg> <command...> - animate the active frame
# set while <command> runs in the background, then overwrite the line with
# `✓ <success-msg>`. On non-zero exit, print `⚠ <running-msg> failed. See <log>`
# and stop. No animation when stdout is redirected, but the command still runs
# and the outcome is still printed. Commands must not carry secrets in argv.
spinner() {
	local running="$1"
	local success="$2"
	shift 2
	local code=0
	if [ -t 1 ]; then
		"$@" >>"$LOG" 2>&1 &
		local pid=$!
		local i=0 n=${#SPIN_FRAMES[@]}
		while kill -0 "$pid" 2>/dev/null; do
			printf '\r%s%s%s %s' "$GREEN" "${SPIN_FRAMES[i % n]}" "$RESET" "$running"
			i=$((i+1))
			sleep 0.08
		done
		wait "$pid" || code=$?
		printf '\r\033[K'
	else
		"$@" >>"$LOG" 2>&1 || code=$?
	fi
	if [ "$code" -eq 0 ]; then
		printf '%s✓%s %s\n' "$GREEN" "$RESET" "$success"
	else
		printf '⚠ %s failed. See %s for details.\n' "$running" "$LOG" >&2
		exit 1
	fi
}

# welcome - the ☼ note that opens the installer. No signature and no contact
# block: it says what the app is and what it will ask, and nothing personal.
welcome() {
	printf '%s☼%s %sBefore we start%s\n\n' "$RESET" "$RESET" "$BOLD" "$RESET"
	printf 'Paratrooper puts a private, phone-friendly chat with your Claude agent on\n'
	printf 'the internet, hosted on Render. This script sets it up and links it to\n'
	printf 'your phone.\n\n'
	printf 'It asks for your Render and Claude Code sign ins, whether the worker\n'
	printf 'should sleep when idle, and an app password. Password typing is hidden. After\n'
	printf 'that it works on its own and prints how to open the app on your phone.\n\n'
}

# prompt_keypress <valid-chars> <prompt-text>
# Read single chars (no Enter required) until one matches a char in
# <valid-chars>. Echo only matched chars; ignore invalid keypresses. Store the
# matched character in REPLY. Returns non-zero if the input ends first, so a
# closed stdin cannot spin here forever.
prompt_keypress() {
	local valid="$1"
	local prompt="$2"
	printf '%s' "$prompt"
	local ch
	while true; do
		if ! IFS= read -s -n 1 -r ch; then
			printf '\n'
			return 1
		fi
		if [ -n "$ch" ] && [[ "$valid" == *"$ch"* ]]; then
			printf '%s\n' "$ch"
			REPLY="$ch"
			return 0
		fi
	done
}

# prompt_secret <prompt-text> <var-name> - read one line with the keystrokes
# hidden, store it in the named variable, and echo nothing back. Returns
# non-zero if the input ended (EOF) rather than a line, so the caller can treat
# a closed stdin as cancel instead of looping on an empty value forever.
prompt_secret() {
	local prompt="$1" var="$2" value="" status=0
	export -n value
	if [ -t 0 ]; then
		TERMINAL_STATE="$(stty -g)" || return 1
		# Hide input before showing the prompt, including immediately typed input.
		stty -echo || return 1
	fi
	printf '%s' "$prompt"
	IFS= read -rs value || status=1
	if [ -n "$TERMINAL_STATE" ]; then
		stty "$TERMINAL_STATE"
		TERMINAL_STATE=""
	fi
	printf '\n'
	printf -v "$var" '%s' "$value"
	return "$status"
}

# Only stdin carries the candidate. Validation prints a fixed rule on failure,
# never the value; its rules match the phone's existing bearer-token contract.
check_app_password() {
	printf '%s' "$APP_PASSWORD" | "$PY" -c '
import sys
from paratrooper.provision import ProvisionError, validate_app_password
try:
    validate_app_password(sys.stdin.read())
except ProvisionError as exc:
    print(exc)
    raise SystemExit(1)
'
}

choose_app_password() {
	local confirmation=""
	export -n confirmation
	printf 'Choose a long passphrase you can remember and type on your phone.\n'
	printf 'Use at least 20 characters, such as several unrelated words. Internal\n'
	printf 'spaces and punctuation are welcome; use printable ASCII characters and\n'
	printf 'leave out spaces at the beginning and end. It will never be displayed.\n'
	printf 'Press Ctrl-C to cancel.\n\n'
	while :; do
		prompt_secret "App password (input hidden): " APP_PASSWORD || return 1
		if ! check_app_password; then
			APP_PASSWORD=""
			continue
		fi
		prompt_secret "Confirm app password (input hidden): " confirmation || return 1
		if [ "$APP_PASSWORD" = "$confirmation" ]; then
			printf '%s✓%s App password confirmed.\n' "$GREEN" "$RESET"
			return 0
		fi
		APP_PASSWORD="" confirmation=""
		printf 'The passwords did not match. Try both entries again.\n'
	done
}

report_field() {
	"$PY" -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' \
		"$REPORT_FILE" "$1" 2>/dev/null || true
}

# need_cmd <command> <hint> - require a command on PATH or stop with the hint.
need_cmd() {
	local cmd="$1" hint="$2"
	if command -v "$cmd" >/dev/null 2>&1; then
		printf '%s✓%s %s found.\n' "$GREEN" "$RESET" "$cmd"
	else
		err ""
		err "⚠ $cmd is required but is not on your PATH."
		err "  $hint"
		exit 1
	fi
}

# wait_for_health <base-url> - poll <base-url><HEALTH_PATH> until it answers or
# the attempts run out. Animates on a TTY; silent when redirected. The poll
# count and gap are overridable so a test can drive it without waiting. Returns
# 0 on the first good answer, non-zero if it never comes.
wait_for_health() {
	local url="$1$HEALTH_PATH"
	local tries="${PARATROOPER_INSTALL_POLL_TRIES:-40}"
	local interval="${PARATROOPER_INSTALL_POLL_INTERVAL:-3}"
	local msg="Waiting for the app to come online ..."
	local i=0 n=${#SPIN_FRAMES[@]}
	while [ "$i" -lt "$tries" ]; do
		if curl -fsS "$url" >>"$LOG" 2>&1; then
			[ -t 1 ] && printf '\r\033[K'
			return 0
		fi
		if [ -t 1 ]; then
			printf '\r%s%s%s %s' "$GREEN" "${SPIN_FRAMES[i % n]}" "$RESET" "$msg"
		fi
		i=$((i+1))
		[ "$interval" -gt 0 ] && sleep "$interval"
	done
	[ -t 1 ] && printf '\r\033[K'
	return 1
}

# venv_ready - is the isolated interpreter present and able to import the tools?
# Used to reuse an environment a previous run built, so a re-run is fast.
venv_ready() {
	[ -x "$PY" ] && "$PY" -c 'import paratrooper.provision, httpx, yaml' >/dev/null 2>&1
}

# build_venv - create the isolated environment and put the project and its
# dependencies in it, without touching the global Python. An air-gapped install
# (OFFLINE_DEPS set) makes a vendored dependency directory and this clone
# importable in the venv; otherwise pip installs the project and the deploy
# extra. Runs under the spinner, so its output goes to the log.
build_venv() {
	rm -rf "$VENVDIR"
	mkdir -p "$(dirname "$VENVDIR")"
	"$PY_BOOT" -m venv "$VENVDIR"
	if [ -n "$OFFLINE_DEPS" ]; then
		"$PY" - "$OFFLINE_DEPS" "$REPO/src" <<'PY'
import os, site, sys
site_dir = site.getsitepackages()[0]
with open(os.path.join(site_dir, "paratrooper_install.pth"), "w") as handle:
    for path in sys.argv[1:]:
        handle.write(path + "\n")
PY
	else
		"$PY" -m pip install --disable-pip-version-check -e "${REPO}[deploy]"
	fi
}

# usable_python3 - is there a python3 on PATH new enough (>= 3.12) to use as is?
usable_python3() {
	command -v python3 >/dev/null 2>&1 &&
		python3 -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 12) else 1)' >/dev/null 2>&1
}

# _download_standalone_python <dest> - the real mechanism for obtaining a Python
# runtime: the astral-sh/python-build-standalone prebuilt "install_only" builds,
# extracted into <dest>, touching no global Python. The pinned version and asset
# naming are documented values to confirm at a real install; the offline tests
# exercise the obtain path through PARATROOPER_INSTALL_PYTHON_INSTALLER instead of
# the network, so this is not run there.
_download_standalone_python() {
	local dest="$1" os arch ver="3.12.7" tag="20241016"
	case "$(uname -s)" in
		Darwin) os="apple-darwin" ;;
		Linux)  os="unknown-linux-gnu" ;;
		*) err "No automatic Python build for $(uname -s)."; return 1 ;;
	esac
	case "$(uname -m)" in
		arm64|aarch64) arch="aarch64" ;;
		x86_64|amd64)  arch="x86_64" ;;
		*) err "No automatic Python build for $(uname -m)."; return 1 ;;
	esac
	local url="https://github.com/astral-sh/python-build-standalone/releases/download/${tag}/cpython-${ver}+${tag}-${arch}-${os}-install_only.tar.gz"
	curl -fsSL "$url" -o "$dest/python.tar.gz"
	tar -xzf "$dest/python.tar.gz" -C "$dest" --strip-components=1
	rm -f "$dest/python.tar.gz"
}

# obtain_python <dest> - install a standalone Python into <dest>. Offline tests
# supply PARATROOPER_INSTALL_PYTHON_INSTALLER, which is handed <dest> and must
# leave a working <dest>/bin/python3.
obtain_python() {
	local dest="$1"
	rm -rf "$dest"
	mkdir -p "$dest"
	if [ -n "${PARATROOPER_INSTALL_PYTHON_INSTALLER:-}" ]; then
		"$PARATROOPER_INSTALL_PYTHON_INSTALLER" "$dest"
	else
		_download_standalone_python "$dest"
	fi
}

# ensure_python - set PY_BOOT to a supported interpreter, obtaining a standalone
# one when the system has none new enough. Never modifies the global Python.
ensure_python() {
	if [ -n "${PARATROOPER_INSTALL_PYTHON_INSTALLER:-}" ]; then
		spinner "Obtaining a Python runtime ..." "Python runtime ready." obtain_python "$CACHE/python"
		PY_BOOT="$CACHE/python/bin/python3"
	elif usable_python3; then
		PY_BOOT="python3"
		printf '%s✓%s python3 found.\n' "$GREEN" "$RESET"
	else
		spinner "Obtaining a Python runtime ..." "Python runtime ready." obtain_python "$CACHE/python"
		PY_BOOT="$CACHE/python/bin/python3"
	fi
	if ! "$PY_BOOT" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 12) else 1)' >>"$LOG" 2>&1; then
		err ""
		err "⚠ Could not get a working Python 3.12+ runtime. See $LOG for details."
		exit 1
	fi
}

# _download_render_cli <dest> - the real mechanism for obtaining the Render CLI:
# the official render-oss/cli GitHub releases, extracted into place. The asset
# naming is a documented value to confirm at a real install; the offline tests
# exercise the obtain path through PARATROOPER_INSTALL_RENDER_INSTALLER instead.
_download_render_cli() {
	local dest="$1" os arch
	case "$(uname -s)" in
		Darwin) os="darwin" ;;
		Linux)  os="linux" ;;
		*) err "No automatic Render CLI build for $(uname -s)."; return 1 ;;
	esac
	case "$(uname -m)" in
		arm64|aarch64) arch="arm64" ;;
		x86_64|amd64)  arch="amd64" ;;
		*) err "No automatic Render CLI build for $(uname -m)."; return 1 ;;
	esac
	local url="https://github.com/render-oss/cli/releases/latest/download/cli_${os}_${arch}.tar.gz"
	curl -fsSL "$url" -o "$dest.tar.gz"
	tar -xzf "$dest.tar.gz" -C "$(dirname "$dest")" render 2>/dev/null ||
		tar -xzf "$dest.tar.gz" -C "$(dirname "$dest")"
	rm -f "$dest.tar.gz"
}

# ensure_render - make the Render CLI available, obtaining it into the cache and
# onto PATH if missing. Only Claude Code is assumed already installed.
ensure_render() {
	if [ -n "${PARATROOPER_INSTALL_RENDER_INSTALLER:-}" ]; then
		mkdir -p "$CACHE/bin"
		spinner "Obtaining the Render CLI ..." "Render CLI ready." \
			"$PARATROOPER_INSTALL_RENDER_INSTALLER" "$CACHE/bin/render"
		chmod +x "$CACHE/bin/render" 2>/dev/null || true
		export PATH="$CACHE/bin:$PATH"
	elif command -v render >/dev/null 2>&1; then
		printf '%s✓%s render found.\n' "$GREEN" "$RESET"
	else
		mkdir -p "$CACHE/bin"
		spinner "Obtaining the Render CLI ..." "Render CLI ready." _download_render_cli "$CACHE/bin/render"
		chmod +x "$CACHE/bin/render" 2>/dev/null || true
		export PATH="$CACHE/bin:$PATH"
	fi
	if ! command -v render >/dev/null 2>&1; then
		err ""
		err "⚠ Could not get the Render CLI. See $LOG for details, or install it from"
		err "  https://render.com/docs/cli and re-run."
		exit 1
	fi
}

# --- 0. preflight ----------------------------------------------------------

if [ ! -f "$BLUEPRINT" ] || [ ! -f "$REPO/pyproject.toml" ]; then
	err "This does not look like the Paratrooper repo (no render.yaml / pyproject.toml)."
	err "Clone the repo and run ./install.sh from inside it."
	exit 1
fi

banner "installer"
printf '\n'
welcome
if ! prompt_keypress "yn" "Ready to begin? (y / n) " || [ "$REPLY" != "y" ]; then
	printf 'No problem. Come back any time.\n'
	exit 0
fi

printf '\nChecking your command line tools ...\n\n'
# Only Claude Code is assumed already installed. A supported Python runtime and
# the Render CLI are obtained automatically when missing, into a per-user cache,
# never into the global Python. This runs after the Ready prompt, so it happens
# only with consent.
ensure_python
ensure_render
need_cmd claude  "Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup"

# Where Render should build from. Taken from this clone's own `origin` remote,
# unless both were passed in (the tests do that so no git call is made). git is
# only required when something is missing and has to be read from the clone.
if [ -z "$REPO_URL" ] || [ -z "$REPO_BRANCH" ]; then
	need_cmd git "Install Git: https://git-scm.com/downloads"
fi
if [ -z "$REPO_URL" ]; then
	REPO_URL="$(git -C "$REPO" remote get-url origin 2>/dev/null || true)"
fi
if [ -z "$REPO_BRANCH" ]; then
	REPO_BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi
if [ -z "$REPO_BRANCH" ] || [ "$REPO_BRANCH" = "HEAD" ]; then
	REPO_BRANCH="main"
fi
if [ -z "$REPO_URL" ]; then
	err ""
	err "⚠ Could not work out this clone's Git repository URL."
	err "  Run the installer from a clone that has an 'origin' remote, or set"
	err "  PARATROOPER_INSTALL_REPO_URL to the repository Render should build from."
	exit 1
fi

# An isolated environment holding the project and its dependencies, built with
# the runtime ensured above so a fresh clone works without anything installed
# into the global Python. Built once and reused on later runs. A slow first build
# is the dependencies installing, so it runs under a spinner.
if venv_ready; then
	printf '%s✓%s Local environment ready.\n' "$GREEN" "$RESET"
else
	spinner "Preparing a local environment (first run can take a few minutes) ..." \
		"Local environment ready." build_venv
fi
if ! "$PY" -c 'import paratrooper.provision, paratrooper.deploy, httpx, yaml' >>"$LOG" 2>&1; then
	err ""
	err "⚠ The local environment is missing Paratrooper or its dependencies."
	err "  Remove $VENVDIR and re-run, or see $LOG for details."
	exit 1
fi

# --- 1. Render sign in -----------------------------------------------------

SPIN_FRAMES=("${SPIN_HEAVY[@]}")
section "1. Render sign in"
printf 'Paratrooper runs on Render. This opens your browser to sign in; the Render\n'
printf 'CLI then saves the session for the rest of the install.\n\n'

if ! render login; then
	err ""
	err "⚠ Render sign in did not complete. Run \`render login\` and try again."
	exit 1
fi

# The delivery tool and the service lookups both read the active workspace the
# CLI saved. Confirm one is selected now, before anything depends on it.
if ! render workspace current >>"$LOG" 2>&1; then
	err ""
	err "⚠ No Render workspace is selected."
	err "  Run \`render workspace set\`, then re-run this installer."
	exit 1
fi
printf '%s✓%s Signed in to Render.\n' "$GREEN" "$RESET"

# --- 2. Claude Code sign in ------------------------------------------------

SPIN_FRAMES=("${SPIN_CIRCLE[@]}")
section "2. Claude Code sign in"
printf 'The worker talks to Claude on your subscription. `claude setup-token` opens\n'
printf 'the browser to authorize, then hands back a long-lived token the worker\n'
printf 'will use. The token is captured quietly and never shown.\n\n'

# Capture stdout (the token); the interactive authorize flow uses the terminal.
# Take the last non-empty line so a stray banner line cannot end up in the value.
if ! CLAUDE_TOKEN="$(claude setup-token | awk 'NF{last=$0} END{print last}')"; then
	err ""
	err "⚠ \`claude setup-token\` did not complete. Try it on its own, then re-run."
	exit 1
fi
CLAUDE_TOKEN="${CLAUDE_TOKEN//[[:space:]]/}"
if [ -z "$CLAUDE_TOKEN" ]; then
	err ""
	err "⚠ No token came back from \`claude setup-token\`. Try it on its own, then re-run."
	exit 1
fi
printf '%s✓%s Claude Code token captured.\n' "$GREEN" "$RESET"

# --- 3. Idle sleeping ------------------------------------------------------

SPIN_FRAMES=("${SPIN_CLASSIC[@]}")
section "3. Idle sleeping"
printf 'A Render worker bills whenever it is awake. Paratrooper can let the web\n'
printf 'service suspend the worker when the queue is empty and wake it when a\n'
printf 'message arrives, so you pay for the worker only while it is thinking.\n\n'
printf '  y - yes, sleep the worker when idle (needs a Render API key)\n'
printf '  n - no, keep the worker always on (no key needed)\n\n'

# Read the idle choice. A closed input (EOF) here is not a silent "no": going on
# would create paid resources with no one at the keyboard, so EOF cancels before
# anything is provisioned. An explicit "n" is the real always-on choice.
if ! prompt_keypress "yn" "answer: "; then
	err ""
	err "⚠ No answer received, so nothing was created. Run ./install.sh again when ready."
	exit 1
fi
if [ "$REPLY" = "y" ]; then
	printf '\n'
	printf 'Find a key under Render: Account Settings -> API Keys. Paste it below.\n'
	printf 'The key lets the web service suspend and resume the worker on your behalf.\n\n'
	while :; do
		if ! prompt_secret "Render API key (input hidden): " RENDER_KEY; then
			err ""
			err "⚠ No key received, so nothing was created. Run ./install.sh again when ready."
			exit 1
		fi
		if [ -n "$RENDER_KEY" ]; then
			break
		fi
		printf 'That was empty. Paste the key, or press Ctrl-C to cancel.\n'
	done
	IDLE_SLEEP="yes"
	printf '%s✓%s Idle sleeping will be turned on.\n' "$GREEN" "$RESET"
else
	IDLE_SLEEP="no"
	printf '\n%s⊘%s Keeping the worker always on.\n' "$DIM" "$RESET"
fi

# --- 4. App password -------------------------------------------------------

section "4. App password"
REPORT_FILE="$(mktemp -t paratrooper-provision.XXXXXX)"
# This is read-only. Determine whether a password is needed before asking for
# one, and bind an existing-install confirmation to that exact web service id.
if ! "$PY" -m paratrooper.provision --inspect-app \
	--blueprint "$BLUEPRINT" --repo "$REPO_URL" --branch "$REPO_BRANCH" \
	--report "$REPORT_FILE"; then
	err "Could not check the existing app. No resources were created."
	exit 1
fi
PASSWORD_MODE="$(report_field password_mode)"
EXISTING_WEB_ID="$(report_field existing_web_id)"
case "$PASSWORD_MODE" in
	new)
		if ! choose_app_password; then
			err "No password confirmed, so no resources were created. Run ./install.sh again when ready."
			exit 1
		fi
		;;
	existing)
		printf 'An app already exists for this repository in your Render workspace.\n'
		printf 'Its current password will be kept. Use that same password on your phone.\n'
		printf 'This installer does not display or reset existing passwords.\n\n'
		if ! prompt_keypress "yn" "Continue keeping the existing app password? (y / n) " || [ "$REPLY" != "y" ]; then
			printf 'Canceled. No resources or passwords were changed.\n'
			exit 1
		fi
		;;
	*) err "Could not determine the app password step. No resources were created."; exit 1 ;;
esac

# Everything the install needs from you has now been collected. From here on it
# runs on its own.

# --- 5. Preparing your deployment ------------------------------------------

SPIN_FRAMES=("${SPIN_HEAVY[@]}")
section "5. Preparing your deployment"
printf 'Writing your configuration, then validating both\n'
printf 'the configuration and the blueprint before anything is sent to Render.\n\n'

# The configuration: the plain profile. It is a chat with photos, web search and
# page reading, and it needs no site, no repository and no GitHub. Every value
# here is a project default, so nothing personal is written to disk.
mkdir -p "$(dirname "$CONFIG_FILE")"
cat > "$CONFIG_FILE" <<'EOF'
# Paratrooper deployment configuration - written by install.sh.
# Plain profile: a phone chat with photos, web search and page reading. No site,
# no repository, no GitHub. Edit it and re-deliver with:
#   python -m paratrooper.deploy push config/paratrooper.toml
schema = 1
model = "claude-sonnet-5"
notifications.reply = "Paratrooper replied."
notifications.error = "Paratrooper hit a problem."
uploads.ttl_hours = 1
profile = "plain"
EOF

# Pre-provision gate 1: the config passes the very validator the services boot
# with, so "it validated" means "it would boot". No network, no secret.
spinner "Validating configuration ..." "Configuration is valid." \
	"$PY" -m paratrooper.deploy check "$CONFIG_FILE"

# Pre-provision gate 2: the blueprint is well formed. The provisioner parses this
# same file to build the resources, so validating it first is validating what it
# is about to read.
spinner "Validating blueprint ..." "Blueprint is valid." \
	render blueprints validate "$BLUEPRINT"

# --- 6. Provisioning on Render ---------------------------------------------

SPIN_FRAMES=("${SPIN_CIRCLE[@]}")
section "6. Provisioning on Render"
printf 'Creating the Key Value store, the worker and the web service from\n'
printf 'render.yaml, wiring their links, secrets and notification keys, then\n'
printf 'waiting for both deploys to go live. Anything already there by name is\n'
printf 'reused, not rebuilt.\n\n'

# The provisioner reports here: ids, the web address, and whether each resource
# was created this run. No secret is written to this file.

# The secrets the new services need, handed over on stdin so they are in no argv
# and in no environment: the write to the service is the only place they go. The
# configuration file is passed by path and is not a secret. The idle-sleeping key
# is included only when it was chosen, and it is a different key from the one that
# signs these API calls: this only ever becomes the web service's RENDER_API_KEY.
provision_payload="CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_TOKEN"
if [ "$PASSWORD_MODE" = "new" ]; then
	provision_payload="$provision_payload
PARATROOPER_APP_TOKEN=$APP_PASSWORD"
fi
if [ "$IDLE_SLEEP" = "yes" ]; then
	provision_payload="$provision_payload
RENDER_API_KEY=$RENDER_KEY"
fi

# Run it directly (not under the spinner) so its one line per resource shows as
# it goes. Its progress and errors name resources and never a secret.
if ! printf '%s\n' "$provision_payload" | "$PY" -m paratrooper.provision \
	--blueprint "$BLUEPRINT" \
	--config "$CONFIG_FILE" \
	--repo "$REPO_URL" \
	--branch "$REPO_BRANCH" \
	--report "$REPORT_FILE" \
	--password-mode "$PASSWORD_MODE" \
	--existing-web-id "$EXISTING_WEB_ID" \
	--wait-ready; then
	err ""
	err "⚠ Provisioning did not finish. Whatever was created is kept and reused,"
	err "  so once the cause above is fixed you can run ./install.sh again to"
	err "  finish. If the app was created, its password is kept on the next run."
	err "  Use the password you chose for that installation."
	exit 1
fi

# Release the shell's copies as soon as provisioning has consumed them.
unset APP_PASSWORD CLAUDE_TOKEN RENDER_KEY provision_payload
WEB_URL="$(report_field web_url)"
DEPLOY_DETAIL="$(report_field deploy_detail)"
VAPID_ON=no;        [ "$(report_field vapid_configured)" = "True" ] && VAPID_ON=yes
DEPLOYS_READY=no;   [ "$(report_field deploys_ready)" = "True" ] && DEPLOYS_READY=yes

# Readiness has two parts, and neither alone is enough: BOTH deploys must be live
# (the worker has no health endpoint of its own, so its deploy status is the only
# signal it started), and then the web must answer its health check.
READY=0
STATUS=""
printf '\n'
if [ "$DEPLOYS_READY" = "yes" ]; then
	if [ -n "$WEB_URL" ] && wait_for_health "$WEB_URL"; then
		READY=1
	else
		STATUS="the web and worker deploys are live, but the app has not answered its health check yet"
	fi
else
	STATUS="${DEPLOY_DETAIL:-the web and worker deploys are not both live yet}"
fi

# --- done ------------------------------------------------------------------

# Say "ready" only when both deploys are live AND the app answered. Anything else
# is created-but-unconfirmed: report it plainly, keep everything, exit non-zero.
if [ "$READY" = 1 ]; then
	printf '\n%s✦%s Paratrooper is ready!\n\n' "$GREEN" "$RESET"
else
	printf '\n%s⚠%s Your Paratrooper resources were created, but the deployment is not\n' "$BOLD" "$RESET"
	printf '  confirmed ready yet:\n'
	printf '    %s.\n' "$STATUS"
	printf '  A first deploy can take several minutes. Nothing was removed.\n\n'
fi

# The app address is the only sign-in detail displayed, including on failure.
if [ -n "$WEB_URL" ]; then
	printf '  %sApp address:%s  %s\n' "$BOLD" "$RESET" "$WEB_URL"
fi
printf '\n'

printf '%sOn your iPhone:%s\n\n' "$BOLD" "$RESET"
printf '  %s1.%s Open the app address above in Safari.\n\n' "$BOLD" "$RESET"
printf '  %s2.%s Add it to your Home Screen:\n\n' "$BOLD" "$RESET"
printf '       Click the share button (the … / box-with-arrow)\n'
printf '       Share\n'
printf '       View more\n'
printf '       Add to Home Screen\n'
printf '       Add and done!\n\n'
printf '  %s3.%s Open Paratrooper from the Home Screen and type your app password to\n' "$BOLD" "$RESET"
printf '     sign in. The connection uses %sHTTPS%s, which the microphone and the\n' "$BOLD" "$RESET"
printf '     Home Screen install both need.\n\n'
if [ "$VAPID_ON" = "yes" ]; then
	printf '  %s4.%s Allow notifications when Paratrooper asks, once it is on your Home\n' "$BOLD" "$RESET"
	printf '     Screen (an iPhone will not notify a browser tab). The notification\n'
	printf '     keys are already configured, so allowing them is all that is left.\n\n'
else
	printf '  %s4.%s Notifications work once the app is on your Home Screen. The\n' "$BOLD" "$RESET"
	printf '     notification keys were not configured this run; set VAPID_PUBLIC_KEY,\n'
	printf '     VAPID_PRIVATE_KEY and VAPID_SUBJECT on the web service to enable them.\n\n'
fi

# A created-but-unconfirmed deployment is an incomplete install: exit non-zero so
# a caller can tell, after pointing the way to finish. Nothing is removed.
if [ "$READY" != 1 ]; then
	printf '  Give it a few minutes, then check the web and worker services in the\n'
	printf '  Render dashboard. Run ./install.sh again to retry; nothing is created twice.\n'
	exit 1
fi
