#!/usr/bin/env bash
# install.sh - set up Paratrooper on Render and link it to your phone.
#
# Run from the cloned repo:
#   ./install.sh
#
# What it does, in order:
#   0. Python: builds an isolated local environment with uv, holding the project
#      and its dependencies, so a fresh clone works and nothing lands in your
#      global Python (built once, reused after).
#   1. Render: makes sure the Render CLI is present, offering to install it into a
#      per-user cache if it is missing, then signs you in (opens the browser; the
#      CLI saves the session).
#   2. Claude Code: makes sure Claude Code is present, offering to install it if
#      it is missing, then mints a worker token with claude setup-token.
#   3. Idle sleeping: offers to let the web service suspend the worker when the
#      queue is empty to cut the Render bill. Skip it and the worker stays on,
#      and no key is needed for that feature.
#   4. App password: checks for an existing app, then either confirms keeping its
#      password or asks for a new password twice with hidden input.
#   Then, with no more questions, two headed sections that ask nothing:
#   Preparing your deployment: writes a plain deployment config, generates the
#      browser-notification (VAPID) keys, and validates the config and the
#      blueprint before touching Render; a failed gate stops here.
#   Provisioning on Render: creates the Key Value store, the worker and the web
#      service from render.yaml, wiring their links, secrets and notification
#      keys, and waits for the app to answer.
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
# Tools obtained on an earlier run live here or in the Claude native install
# directory. Keep caller tools ahead of both locations in a fresh shell.
export PATH="${PATH:+$PATH:}$CACHE/bin:$HOME/.local/bin"
# The isolated environment the project's laptop tools run in, and its Python.
# Built by step 0 with uv so a fresh clone works; reused if already present.
VENVDIR="${PARATROOPER_INSTALL_VENV:-$CACHE/venv}"
PY="$VENVDIR/bin/python"
# How step 0 asks uv to build the environment: reuse an existing python3
# (>= 3.12) when there is one, otherwise let uv provide a managed Python kept in
# uv's own cache. Set by step 0 before the venv is built; never the global Python.
UV_VENV_ARGS=(--python 3.12)
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
# Holds the provisioner's stderr (its "error: ..." line) while the provisioning
# spinner animates, so a failure prints it cleanly once the spinner is erased.
PROVISION_ERR=""
WORKSPACE_ERR=""
WORKSPACE_OUT=""
VALIDATION_OUT=""
TERMINAL_STATE=""
INITIAL_TERMINAL_STATE=""
TTY_FD_OPEN="no"
if [ -t 0 ]; then
	exec 9<&0
	TTY_FD_OPEN="yes"
	INITIAL_TERMINAL_STATE="$(stty -g <&9 2>/dev/null || true)"
fi
ACTIVE_CHILD_PID=""
TOKEN_DIR=""
PROVISION_STARTED="no"
PASSWORD_MODE=""
EXISTING_WEB_ID=""
WORKSPACE_ID=""
WORKSPACE_NAME=""

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

# A PATH match can name a stale file that is not executable.
tool_usable() {
	local found
	found="$(command -v "$1" 2>/dev/null)" || return 1
	[ -f "$found" ] && [ -x "$found" ]
}

# cleanup - restore the terminal and remove the non-secret report on the way out.
cleanup() {
	if [ -n "$INITIAL_TERMINAL_STATE" ]; then
		stty "$INITIAL_TERMINAL_STATE" <&9 2>/dev/null || true
	elif [ -n "$TERMINAL_STATE" ]; then
		stty "$TERMINAL_STATE" <&9 2>/dev/null || true
	fi
	[ "$TTY_FD_OPEN" = "no" ] || exec 9<&-
	[ -n "$REPORT_FILE" ] && rm -f "$REPORT_FILE" 2>/dev/null
	[ -n "$PROVISION_ERR" ] && rm -f "$PROVISION_ERR" 2>/dev/null
	[ -n "$WORKSPACE_ERR" ] && rm -f "$WORKSPACE_ERR" 2>/dev/null
	[ -n "$WORKSPACE_OUT" ] && rm -f "$WORKSPACE_OUT" 2>/dev/null
	[ -n "$VALIDATION_OUT" ] && rm -f "$VALIDATION_OUT" 2>/dev/null
	[ -n "$TOKEN_DIR" ] && rm -rf "$TOKEN_DIR" 2>/dev/null
	unset APP_PASSWORD CLAUDE_TOKEN RENDER_KEY provision_payload
	return 0
}
trap cleanup EXIT

# Bash postpones an INT trap while it waits for a foreground child. Run lengthy
# tools as tracked background children and wait for them instead. A Ctrl-C then
# interrupts the wait immediately, including while a browser sign-in is pending.
# Only descendants of the active installer command are stopped. Unrelated app
# processes, including an already-open browser, are never selected for cleanup.
owned_child_pids() {
	local root="$1"
	ps -eo pid=,ppid= 2>/dev/null | awk -v root="$root" '
		{ parent[$1] = $2; order[++count] = $1 }
		END {
			owned[root] = 1
			for (pass = 0; pass < count; pass++) {
				changed = 0
				for (i = 1; i <= count; i++)
					if (owned[parent[order[i]]] && !owned[order[i]]) {
						owned[order[i]] = 1; changed = 1
					}
				if (!changed) break
			}
			for (i = 1; i <= count; i++) if (owned[order[i]] && order[i] != root) print order[i]
		}' || true
}

stop_active_child() {
	local pid descendants attempt
	[ -n "$ACTIVE_CHILD_PID" ] || return 0
	descendants="$(owned_child_pids "$ACTIVE_CHILD_PID")"
	# Stop descendants while their parent is still alive. Never send a delayed
	# SIGKILL to a saved descendant PID: it might have exited and been reused.
	for pid in $descendants; do kill -TERM "$pid" 2>/dev/null || true; done
	for pid in $descendants; do kill -KILL "$pid" 2>/dev/null || true; done
	kill -TERM "$ACTIVE_CHILD_PID" 2>/dev/null || true
	for attempt in 1 2 3 4 5; do
		kill -0 "$ACTIVE_CHILD_PID" 2>/dev/null || break
		sleep 0.1
	done
	# Bash may already have reaped a finished child. Its running-jobs list is
	# authoritative for this shell; a reused PID cannot appear there by accident.
	if jobs -pr | grep -Fxq "$ACTIVE_CHILD_PID"; then
		kill -KILL "$ACTIVE_CHILD_PID" 2>/dev/null || true
	fi
	wait "$ACTIVE_CHILD_PID" 2>/dev/null || true
	ACTIVE_CHILD_PID=""
}

stop_install() {
	local code="$1"
	trap '' INT TERM HUP
	stop_active_child
	if [ "$code" -eq 130 ]; then
		err ""
		err "Installation canceled. Run ./install.sh again when ready."
		if [ "$PROVISION_STARTED" = yes ]; then
			err "Any Render resources already created were kept; the next run can reuse them."
		fi
	fi
	exit "$code"
}
trap 'stop_install 130' INT
trap 'stop_install 143' TERM
trap 'stop_install 129' HUP

wait_active_child() {
	local status=0
	wait "$ACTIVE_CHILD_PID" || status=$?
	ACTIVE_CHILD_PID=""
	return "$status"
}

run_owned() {
	"$@" &
	ACTIVE_CHILD_PID=$!
	wait_active_child
}

run_owned_tty() {
	"$@" <&0 &
	ACTIVE_CHILD_PID=$!
	wait_active_child
}

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
# The app's #4538FF accent on the left fades to pale violet on the right.
banner() {
	local subtitle="${1:-}"
	# The wordmark is drawn with python3. This runs before the runtime is ensured,
	# so if there is no python3 yet, fall back to a plain title rather than fail.
	if ! tool_usable python3; then
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
START = (69, 56, 255)
END = (201, 197, 255)
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
	"$@" >>"$LOG" 2>&1 &
	local pid=$!
	ACTIVE_CHILD_PID="$pid"
	if [ -t 1 ]; then
		local i=0 n=${#SPIN_FRAMES[@]}
		while kill -0 "$pid" 2>/dev/null; do
			printf '\r%s%s%s %s' "$GREEN" "${SPIN_FRAMES[i % n]}" "$RESET" "$running"
			i=$((i+1))
			sleep 0.08
		done
		wait_active_child || code=$?
		printf '\r\033[K'
	else
		wait_active_child || code=$?
	fi
	if [ "$code" -eq 0 ]; then
		printf '%s✓%s %s\n' "$GREEN" "$RESET" "$success"
	else
		printf '⚠ %s failed. See %s for details.\n' "$running" "$LOG" >&2
		exit 1
	fi
}

# spin_pid <pid> <running-msg> - animate the active frame set while the process
# <pid> runs, then erase the line. Unlike spinner(), it leaves no success line of
# its own, for work whose result is printed separately (provisioning, then the
# readiness result). No animation when stdout is redirected; the caller still
# waits on the process for its exit status.
spin_pid() {
	local pid="$1" running="$2" i=0 n=${#SPIN_FRAMES[@]}
	[ -t 1 ] || return 0
	while kill -0 "$pid" 2>/dev/null; do
		printf '\r%s%s%s %s' "$GREEN" "${SPIN_FRAMES[i % n]}" "$RESET" "$running"
		i=$((i+1))
		sleep 0.08
	done
	printf '\r\033[K'
}

# welcome - the ☼ note that opens the installer and describes the app.
welcome() {
	printf '%s☼%s %sBefore we start%s\n\n' "$RESET" "$RESET" "$BOLD" "$RESET"
	printf 'Paratrooper allows you to interact with your agent on the cloud\n'
	printf 'using an iMessage-like interface. This install script sets up a\n'
	printf 'basic chat version of the Paratrooper on Render. Once installed, you\n'
	printf 'will be able to access the chat interface on your iPhone as a PWA.\n\n'
}

# prompt_keypress <valid-chars> <prompt-text>
# Read single chars (no Enter required) until one matches a char in
# <valid-chars>. Echo only matched chars; ignore invalid keypresses. Store the
# matched character in REPLY. Returns non-zero if the input ends first, so a
# closed stdin cannot spin here forever.
prompt_keypress() {
	local valid="$1"
	local prompt="$2"
	if [ -t 0 ]; then
		TERMINAL_STATE="$(stty -g)" || return 1
	fi
	printf '%s' "$prompt"
	local ch
	while true; do
		if ! IFS= read -s -n 1 -r ch; then
			if [ -n "$TERMINAL_STATE" ]; then
				stty "$TERMINAL_STATE"
				TERMINAL_STATE=""
			fi
			printf '\n'
			return 1
		fi
		if [ -n "$ch" ] && [[ "$valid" == *"$ch"* ]]; then
			if [ -n "$TERMINAL_STATE" ]; then
				stty "$TERMINAL_STATE"
				TERMINAL_STATE=""
			fi
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
	printf 'Choose a strong password to log into your Paratrooper instance.\n'
	printf 'Use at least 11 characters, with a letter, a number and a symbol.\n\n'
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

# Keep the OAuth token in shell memory. A private FIFO lets the parent read the
# CLI's stdout while it tracks the CLI PID; unlike command substitution, a read
# from the FIFO is interrupted promptly by Ctrl-C. Nothing is saved in the FIFO.
capture_claude_token() {
	local line="" status=0
	export -n line
	TOKEN_DIR="$(mktemp -d -t paratrooper-token.XXXXXX)" || return 1
	mkfifo "$TOKEN_DIR/stdout" || return 1
	claude setup-token <&0 >"$TOKEN_DIR/stdout" &
	ACTIVE_CHILD_PID=$!
	while IFS= read -r line || [ -n "$line" ]; do
		if [[ "$line" =~ [^[:space:]] ]]; then CLAUDE_TOKEN="$line"; fi
	done <"$TOKEN_DIR/stdout"
	wait_active_child || status=$?
	rm -rf "$TOKEN_DIR"
	TOKEN_DIR=""
	return "$status"
}

is_cloudflare_blueprint_block() {
	grep -Fq 'validation request failed with status 403:' "$1" &&
		grep -Fq 'Attention Required! | Cloudflare' "$1" &&
		grep -Fq 'Sorry, you have been blocked' "$1"
}

validate_blueprint() {
	local status=0
	VALIDATION_OUT="$(mktemp -t paratrooper-blueprint.XXXXXX)" || return 1
	render blueprints validate "$BLUEPRINT" >"$VALIDATION_OUT" 2>&1 &
	ACTIVE_CHILD_PID=$!
	spin_pid "$ACTIVE_CHILD_PID" "Validating blueprint ..."
	wait_active_child || status=$?
	cat "$VALIDATION_OUT" >>"$LOG"
	if [ "$status" -eq 0 ]; then
		printf '%s✓%s Blueprint is valid.\n' "$GREEN" "$RESET"
	elif is_cloudflare_blueprint_block "$VALIDATION_OUT"; then
		err "⚠ Render's Blueprint preflight was blocked by Cloudflare."
		err "  Render has not checked the Blueprint. See $LOG for the block details."
		if [ ! -t 0 ] || [ ! -t 1 ]; then
			err "  Run interactively to choose whether to continue. No resources were created."
			rm -f "$VALIDATION_OUT"; VALIDATION_OUT=""
			return 1
		fi
		printf 'Later Render API checks may still reject this setup after creating some resources.\n'
		if ! prompt_keypress "yn" "Continue without Render's preflight check? (y / n) " || [ "$REPLY" != y ]; then
			err "Setup stopped before creating resources."
			rm -f "$VALIDATION_OUT"; VALIDATION_OUT=""
			return 1
		fi
		printf "⚠ Continuing without Render's Blueprint preflight.\n"
	else
		err "⚠ Validating blueprint ... failed. See $LOG for details."
		rm -f "$VALIDATION_OUT"; VALIDATION_OUT=""
		return 1
	fi
	rm -f "$VALIDATION_OUT"
	VALIDATION_OUT=""
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
		if run_owned curl -fsS "$url" >>"$LOG" 2>&1; then
			[ -t 1 ] && printf '\r\033[K'
			return 0
		fi
		if [ -t 1 ]; then
			printf '\r%s%s%s %s' "$GREEN" "${SPIN_FRAMES[i % n]}" "$RESET" "$msg"
		fi
		i=$((i+1))
		if [ "$interval" -gt 0 ]; then run_owned sleep "$interval"; fi
	done
	[ -t 1 ] && printf '\r\033[K'
	return 1
}

# venv_ready - is the isolated interpreter present and able to import the tools?
# Used to reuse an environment a previous run built, so a re-run is fast.
venv_ready() {
	[ -x "$PY" ] && "$PY" -c 'import paratrooper.provision, httpx, yaml' >/dev/null 2>&1
}

# build_venv - create the isolated environment with uv and put the project and
# its dependencies in it, without touching the global Python. uv supplies the
# interpreter (an existing python3 reused, or a managed one in uv's own cache,
# per UV_VENV_ARGS) and creates the environment. An air-gapped install
# (OFFLINE_DEPS set) makes a vendored dependency directory and this clone
# importable in the venv; otherwise uv installs the project and the deploy
# extra. Runs under the spinner, so its output goes to the log.
build_venv() {
	rm -rf "$VENVDIR"
	mkdir -p "$(dirname "$VENVDIR")"
	uv venv "${UV_VENV_ARGS[@]}" "$VENVDIR"
	if [ -n "$OFFLINE_DEPS" ]; then
		"$PY" - "$OFFLINE_DEPS" "$REPO/src" <<'PY'
import os, site, sys
site_dir = site.getsitepackages()[0]
with open(os.path.join(site_dir, "paratrooper_install.pth"), "w") as handle:
    for path in sys.argv[1:]:
        handle.write(path + "\n")
PY
	else
		uv pip install --python "$PY" -e "${REPO}[deploy]"
	fi
}

# usable_python3 - is there a python3 on PATH new enough (>= 3.12) to use as is?
usable_python3() {
	tool_usable python3 &&
		python3 -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 12) else 1)' >/dev/null 2>&1
}

# _download_uv <dest> - the real mechanism for obtaining uv: the official
# astral-sh/uv GitHub releases, extracted into place. The asset naming is a
# documented value to confirm at a real install; the offline tests exercise the
# obtain path through PARATROOPER_INSTALL_UV_INSTALLER instead of the network, so
# this is not run there.
_download_uv() {
	local dest="$1" os arch
	case "$(uname -s)" in
		Darwin) os="apple-darwin" ;;
		Linux)  os="unknown-linux-gnu" ;;
		*) err "No automatic uv build for $(uname -s)."; return 1 ;;
	esac
	case "$(uname -m)" in
		arm64|aarch64) arch="aarch64" ;;
		x86_64|amd64)  arch="x86_64" ;;
		*) err "No automatic uv build for $(uname -m)."; return 1 ;;
	esac
	local url="https://github.com/astral-sh/uv/releases/latest/download/uv-${arch}-${os}.tar.gz"
	curl -fsSL "$url" -o "$dest.tar.gz"
	tar -xzf "$dest.tar.gz" -C "$(dirname "$dest")" --strip-components=1 "uv-${arch}-${os}/uv" 2>/dev/null ||
		tar -xzf "$dest.tar.gz" -C "$(dirname "$dest")"
	rm -f "$dest.tar.gz"
}

# ensure_uv - use an existing uv or ask before obtaining it into the per-user
# cache. Offline tests supply PARATROOPER_INSTALL_UV_INSTALLER, which is handed
# the destination path after consent and must leave a working uv there.
ensure_uv() {
	if tool_usable uv; then
		printf '%s✓%s uv found.\n' "$GREEN" "$RESET"
		return 0
	fi
	printf 'uv is not installed. It can be downloaded into a\n'
	printf 'per-user cache, without touching your system directories.\n\n'
	if ! prompt_keypress "yn" "Download and install uv now? (y / n) " || [ "$REPLY" != "y" ]; then
		printf '\nNo problem. Install uv from\n'
		printf 'https://docs.astral.sh/uv/getting-started/installation/,\n'
		printf 'then run ./install.sh again when ready.\n'
		exit 0
	fi
	printf '\n'
	mkdir -p "$CACHE/bin"
	if [ -n "${PARATROOPER_INSTALL_UV_INSTALLER:-}" ]; then
		spinner "Obtaining uv ..." "uv ready." \
			"$PARATROOPER_INSTALL_UV_INSTALLER" "$CACHE/bin/uv"
	else
		spinner "Obtaining uv ..." "uv ready." _download_uv "$CACHE/bin/uv"
	fi
	chmod +x "$CACHE/bin/uv" 2>/dev/null || true
	if ! tool_usable uv; then
		err ""
		err "⚠ Could not download uv."
		err "  See $LOG for details, or install it from"
		err "  https://docs.astral.sh/uv/getting-started/installation/ and re-run."
		exit 1
	fi
}

# _download_render_cli <dest> - the real mechanism for obtaining the Render CLI:
# use the versioned ZIP published by the official render-oss/cli releases and
# extract its CLI binary into the per-user cache.
_download_render_cli() {
	local dest="$1" os arch version version_num archive url tmpdir
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
	command -v unzip >/dev/null 2>&1 || { err "unzip is required to install the Render CLI."; return 1; }
	version="$(curl -fsSL https://api.github.com/repos/render-oss/cli/releases/latest |
		sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')" || return 1
	[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { err "Could not read the latest Render CLI version."; return 1; }
	version_num="${version#v}"
	url="https://github.com/render-oss/cli/releases/download/${version}/cli_${version_num}_${os}_${arch}.zip"
	tmpdir="$(mktemp -d)" || return 1
	archive="$tmpdir/render.zip"
	if ! curl -fsSL "$url" -o "$archive" ||
		! unzip -p "$archive" "cli_v${version_num}" > "$tmpdir/render" ||
		[ ! -s "$tmpdir/render" ] ||
		! chmod +x "$tmpdir/render" ||
		! mv "$tmpdir/render" "$dest"; then
		rm -rf "$tmpdir"
		return 1
	fi
	rm -rf "$tmpdir"
}

# obtain_render - download the Render CLI into the per-user cache already on PATH.
# Offline tests supply PARATROOPER_INSTALL_RENDER_INSTALLER, handed the
# destination path. Stops the run if the CLI still is not callable afterwards.
obtain_render() {
	mkdir -p "$CACHE/bin"
	if [ -n "${PARATROOPER_INSTALL_RENDER_INSTALLER:-}" ]; then
		spinner "Obtaining the Render CLI ..." "Render CLI ready." \
			"$PARATROOPER_INSTALL_RENDER_INSTALLER" "$CACHE/bin/render"
	else
		spinner "Obtaining the Render CLI ..." "Render CLI ready." _download_render_cli "$CACHE/bin/render"
	fi
	chmod +x "$CACHE/bin/render" 2>/dev/null || true
	if ! tool_usable render; then
		err ""
		err "⚠ Could not download the Render CLI."
		err "  See $LOG for details, or install it from"
		err "  https://render.com/docs/cli and re-run."
		exit 1
	fi
}

# ensure_render - step 1's Render CLI check. If it is already on PATH, say so. If
# not, explain in one sentence, then ask to install it: y downloads it into the
# per-user cache, n (or a closed stdin) stops politely with the manual link.
ensure_render() {
	if tool_usable render; then
		printf '%s✓%s render found.\n' "$GREEN" "$RESET"
		return 0
	fi
	printf 'The Render command line tool is not installed.\n'
	printf 'It can be downloaded into a per-user cache,\n'
	printf 'without touching your system directories.\n\n'
	if ! prompt_keypress "yn" "Download and install the Render CLI now? (y / n) " || [ "$REPLY" != "y" ]; then
		printf '\nNo problem. Install the Render CLI from\n'
		printf 'https://render.com/docs/cli, then run\n'
		printf './install.sh again when ready.\n'
		exit 0
	fi
	printf '\n'
	obtain_render
}

# _install_claude_code - the real mechanism for installing Claude Code: its
# official native installer, which places the binary under ~/.local/bin. The
# command is the documented one; it could not be confirmed with a read-only GET
# from this build's environment (see the delivery REPORT.txt). Offline tests
# supply PARATROOPER_INSTALL_CLAUDE_INSTALLER instead, so this is not run there.
_install_claude_code() {
	curl -fsSL https://claude.ai/install.sh | bash
}

# obtain_claude - install Claude Code, then re-check ~/.local/bin (where its
# native installer puts the binary). Stops if claude still is not callable.
obtain_claude() {
	if [ -n "${PARATROOPER_INSTALL_CLAUDE_INSTALLER:-}" ]; then
		spinner "Installing Claude Code ..." "Claude Code installed." \
			"$PARATROOPER_INSTALL_CLAUDE_INSTALLER"
	else
		spinner "Installing Claude Code ..." "Claude Code installed." _install_claude_code
	fi
	if ! tool_usable claude; then
		err ""
		err "⚠ Could not install Claude Code."
		err "  See $LOG for details, or install it from"
		err "  https://docs.claude.com/en/docs/claude-code/setup and re-run."
		exit 1
	fi
}

# ensure_claude - step 2's Claude Code check. If it is already on PATH, say so.
# If not, explain in one sentence, then ask to install it: y runs the official
# installer, n (or a closed stdin) stops politely with the setup link.
ensure_claude() {
	if tool_usable claude; then
		printf '%s✓%s claude found.\n' "$GREEN" "$RESET"
		return 0
	fi
	printf 'Claude Code is not installed. Its official installer places it under\n'
	printf '~/.local/bin, without touching your system directories.\n\n'
	if ! prompt_keypress "yn" "Download and install Claude Code now? (y / n) " || [ "$REPLY" != "y" ]; then
		printf '\nNo problem. Install Claude Code from\n'
		printf 'https://docs.claude.com/en/docs/claude-code/setup,\n'
		printf 'then run ./install.sh again when ready.\n'
		exit 0
	fi
	printf '\n'
	obtain_claude
}

# Read the CLI's active workspace as structured output. The CLI resolves a
# RENDER_WORKSPACE override before its saved config; after the user chooses a
# different workspace, ignore that override to read the new saved choice.
read_render_workspace() {
	local raw fields errors status=0
	WORKSPACE_ERR="$(mktemp -t paratrooper-workspace.XXXXXX)" || return 1
	WORKSPACE_OUT="$(mktemp -t paratrooper-workspace-out.XXXXXX)" || return 1
	if [ "${1:-}" = "saved" ]; then
		run_owned_tty env -u RENDER_WORKSPACE render workspace current --output json >"$WORKSPACE_OUT" 2>"$WORKSPACE_ERR" || status=$?
	else
		run_owned_tty render workspace current --output json >"$WORKSPACE_OUT" 2>"$WORKSPACE_ERR" || status=$?
	fi
	raw="$(cat "$WORKSPACE_OUT")"
	errors="$(cat "$WORKSPACE_ERR")"
	[ -z "$errors" ] || printf '%s\n' "$errors" >>"$LOG"
	rm -f "$WORKSPACE_ERR" "$WORKSPACE_OUT"
	WORKSPACE_ERR=""
	WORKSPACE_OUT=""
	if [ "$status" -ne 0 ]; then
		[ -z "$raw" ] || printf '%s\n' "$raw" >>"$LOG"
		[[ "$errors" == *"no workspace set."* ]] && return 2
		return 1
	fi
	if ! fields="$(printf '%s' "$raw" | "$PY" -c '
import json, re, sys
try:
    workspace = json.load(sys.stdin)
    ident = workspace["id"]
    name = workspace["name"]
    if not isinstance(ident, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", ident):
        raise ValueError("invalid workspace ID")
    if not isinstance(name, str):
        raise ValueError("invalid workspace name")
    name = " ".join("".join(c for c in name if c.isprintable()).split())
    if not name:
        raise ValueError("empty workspace name")
    print(f"{ident}\t{name}")
except (KeyError, TypeError, ValueError, json.JSONDecodeError):
    raise SystemExit(1)
')"; then
		printf 'Render workspace current returned an unreadable workspace.\n' >>"$LOG"
		return 1
	fi
	IFS=$'\t' read -r WORKSPACE_ID WORKSPACE_NAME <<< "$fields"
	printf 'Render workspace: %s (%s)\n' "$WORKSPACE_NAME" "$WORKSPACE_ID" >>"$LOG"
}

select_render_workspace() {
	printf '\nChoose a Render workspace to continue.\n\n'
	# The CLI picker writes the user's choice to its config. A pre-existing
	# environment override must not hide that choice when we read it back. The
	# result is shown for explicit confirmation even if the picker was canceled.
	run_owned_tty env -u RENDER_WORKSPACE render workspace set || return 1
	read_render_workspace saved
}

# --- start-up --------------------------------------------------------------

if [ ! -f "$BLUEPRINT" ] || [ ! -f "$REPO/pyproject.toml" ]; then
	err "This does not look like the Paratrooper repo."
	err "Clone it and run ./install.sh from inside it."
	exit 1
fi

banner "installer"
printf '\n'
welcome
if ! prompt_keypress "yn" "Ready to begin? (y / n) " || [ "$REPLY" != "y" ]; then
	printf 'No problem. Come back any time.\n'
	exit 0
fi

# Where Render should build from. Taken from this clone's own `origin` remote,
# unless both were passed in (the tests do that so no git call is made). git is
# only needed to read a value from the clone; this stays silent and adds no step.
# Each tool check now lives inside its own numbered step below.
if [ -z "$REPO_URL" ] || [ -z "$REPO_BRANCH" ]; then
	if ! command -v git >/dev/null 2>&1; then
		err ""
		err "⚠ Paratrooper needs Git, but it is not installed."
		err "  Install it from https://git-scm.com/downloads"
		err "  and run ./install.sh again."
		exit 1
	fi
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
	err "⚠ Could not work out where this copy of Paratrooper came from."
	err "  Run the installer from a clone of the repo, not a downloaded copy."
	exit 1
fi

# --- 0. Python -------------------------------------------------------------

SPIN_FRAMES=("${SPIN_HEAVY[@]}")
section "0. Python"
printf 'Setup needs a few Python tools. It puts them in a\n'
printf 'private folder using uv, so it never touches existing\n'
printf 'Python installation you may have on your computer.\n\n'

# An environment a previous run already built is reused as is: no uv, no
# interpreter search, just the fast path. Otherwise uv provides the interpreter
# (an existing python3 >= 3.12 is reused, else uv fetches a managed one into its
# own cache) and builds the environment. A slow first build is the dependencies
# installing, so it runs under a spinner.
if venv_ready; then
	printf '%s✓%s Local environment ready.\n' "$GREEN" "$RESET"
else
	ensure_uv
	if usable_python3; then
		UV_VENV_ARGS=(--python "$(command -v python3)")
		printf '%s✓%s python3 found.\n' "$GREEN" "$RESET"
	else
		UV_VENV_ARGS=(--python-preference only-managed --python 3.12)
		printf '%s✓%s uv will provide a managed Python in its own cache.\n' "$GREEN" "$RESET"
	fi
	spinner "Preparing a local environment (first run can take a few minutes) ..." \
		"Local environment ready." build_venv
fi
if ! "$PY" -c 'import paratrooper.provision, paratrooper.deploy, httpx, yaml' >>"$LOG" 2>&1; then
	err ""
	err "⚠ The Python tools did not install properly."
	err "  Delete $VENVDIR and re-run, or see $LOG for details."
	exit 1
fi

# --- 1. Render -------------------------------------------------------------

SPIN_FRAMES=("${SPIN_HEAVY[@]}")
section "1. Render"
printf 'Paratrooper runs on Render. This step makes sure the Render\n'
printf 'command line tool is available, then opens your browser to\n'
printf 'sign in; the Render CLI saves the session for the rest of the install.\n\n'

# The Render CLI check lives in this step: present is announced, missing offers a
# y/n install into the per-user cache before the sign in.
ensure_render

if ! run_owned_tty render login; then
	err ""
	err "⚠ Render sign in did not complete."
	err "  Run \`render login\` and try again."
	exit 1
fi

# The CLI can save a workspace from an earlier use, or inherit an override from
# the shell. Show the actual target and ask before any app resource is inspected.
if read_render_workspace; then
	:
else
	workspace_status=$?
	if [ "$workspace_status" -ne 2 ]; then
		err ""
		err "⚠ Could not check your Render workspace."
		err "  See $LOG for details."
		exit 1
	fi
	if ! select_render_workspace; then
		err ""
		err "⚠ No Render workspace was selected."
		err "  Choose or create a workspace in Render, then run ./install.sh again."
		exit 1
	fi
fi
while :; do
	printf '\nRender workspace: %s (%s)\n' "$WORKSPACE_NAME" "$WORKSPACE_ID"
	printf '  y - use this workspace\n'
	printf '  s - select another workspace\n'
	printf '  n - stop here\n\n'
	if ! prompt_keypress "ysn" "Use this workspace for Paratrooper? (y / s / n) "; then
		err ""
		err "⚠ No workspace was confirmed. Run ./install.sh again when ready."
		exit 1
	fi
	case "$REPLY" in
		y) printf '\n'; break ;;
		n) printf 'No problem. Installation stopped before deployment.\n'; exit 0 ;;
		s)
			if ! select_render_workspace; then
				err ""
				err "⚠ No Render workspace was selected."
				err "  Choose or create a workspace in Render, then run ./install.sh again."
				exit 1
			fi
			;;
	esac
done
printf '%s✓%s Render workspace confirmed.\n' "$GREEN" "$RESET"
printf '%s✓%s Signed in to Render.\n' "$GREEN" "$RESET"

# --- 2. Claude Code --------------------------------------------------------

SPIN_FRAMES=("${SPIN_CIRCLE[@]}")
section "2. Claude Code"
printf 'The worker talks to Claude on your subscription. This step makes\n'
printf 'sure Claude Code is available, then `claude setup-token` opens\n'
printf 'the browser to authorize and hands back a long-lived token the\n'
printf 'worker will use. The token is captured quietly and never shown.\n\n'

# The Claude Code check lives in this step: present is announced, missing offers a
# y/n install through its official installer before the sign in.
ensure_claude

# Capture stdout (the token); the interactive authorize flow uses the terminal.
# Take the last non-empty line so a stray banner line cannot end up in the value.
if ! capture_claude_token; then
	err ""
	err "⚠ Claude Code sign in did not complete."
	err "  Run \`claude setup-token\` and try again."
	exit 1
fi
CLAUDE_TOKEN="${CLAUDE_TOKEN//[[:space:]]/}"
if [ -z "$CLAUDE_TOKEN" ]; then
	err ""
	err "⚠ Claude Code sign in did not complete."
	err "  Run \`claude setup-token\` and try again."
	exit 1
fi
printf '%s✓%s Claude Code token captured.\n' "$GREEN" "$RESET"

# --- 3. Idle sleeping ------------------------------------------------------

SPIN_FRAMES=("${SPIN_CLASSIC[@]}")
section "3. Idle sleeping"
printf 'Render bills you whenever the worker on the server is awake. Paratrooper\n'
printf 'can let the web service suspend the worker and wake it only when a new\n'
printf 'message arrives, so you pay for the worker only while it is thinking.\n\n'
printf '  y - yes, sleep the worker when idle (needs a Render API key)\n'
printf '  n - no, keep the worker always on (no key needed)\n\n'

# Read the idle choice. A closed input (EOF) here is not a silent "no": going on
# would create paid resources with no one at the keyboard, so EOF cancels before
# anything is provisioned. An explicit "n" is the real always-on choice.
if ! prompt_keypress "yn" "answer: "; then
	err ""
	err "⚠ No answer, so nothing was set up. Run ./install.sh again when ready."
	exit 1
fi
if [ "$REPLY" = "y" ]; then
	printf '\n'
	printf 'Find a key under Render: Account Settings -> API Keys.\n'
	printf 'Paste it below. The key lets the web service\n'
	printf 'suspend and resume the worker on your behalf.\n\n'
	while :; do
		if ! prompt_secret "Render API key (input hidden): " RENDER_KEY; then
			err ""
			err "⚠ No key, so nothing was set up. Run ./install.sh again when ready."
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
if ! run_owned "$PY" -m paratrooper.provision --inspect-app \
	--blueprint "$BLUEPRINT" --repo "$REPO_URL" --branch "$REPO_BRANCH" \
	--workspace "$WORKSPACE_ID" \
	--report "$REPORT_FILE"; then
	err "Could not check your existing app. Nothing was set up."
	exit 1
fi
PASSWORD_MODE="$(report_field password_mode)"
EXISTING_WEB_ID="$(report_field existing_web_id)"
case "$PASSWORD_MODE" in
	new)
		if ! choose_app_password; then
			err "No password, so nothing was set up. Run ./install.sh again when ready."
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
	*) err "Could not tell whether this is a new app"; err "or an existing one. Nothing was set up."; exit 1 ;;
esac

# Everything the install needs from you has now been collected. From here on it
# runs on its own.

# --- Preparing your deployment (unnumbered: asks nothing) ------------------

SPIN_FRAMES=("${SPIN_HEAVY[@]}")
section "Preparing your deployment"
printf 'Writing your configuration, then validating both the config\n'
printf 'and the blueprint before anything is sent to Render.\n\n'

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
validate_blueprint

# --- Provisioning on Render (unnumbered: asks nothing) ---------------------

SPIN_FRAMES=("${SPIN_CIRCLE[@]}")
section "Provisioning on Render"
printf 'Setting up your app on Render and waiting for it to go live.\n'
printf 'This can take a few minutes. Anything already set up is reused.\n\n'

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

# Run the provisioner with its per-resource progress and its poll-by-poll
# "waiting for the deploy" lines going to the log, not the screen: only the two
# lines above, the wait spinner and the result are shown. Its own "error: ..."
# line (stderr) is held in a file so a failure prints it cleanly once the spinner
# is erased, above the guidance below. Secrets travel on stdin, in no argv and no
# environment; printf is a builtin, so the payload never reaches the process table.
run_provisioner() {
	printf '%s\n' "$provision_payload" | "$PY" -m paratrooper.provision \
		--blueprint "$BLUEPRINT" \
		--config "$CONFIG_FILE" \
		--repo "$REPO_URL" \
		--branch "$REPO_BRANCH" \
		--workspace "$WORKSPACE_ID" \
		--report "$REPORT_FILE" \
		--password-mode "$PASSWORD_MODE" \
		--existing-web-id "$EXISTING_WEB_ID" \
		--wait-ready >>"$LOG" 2>>"$PROVISION_ERR"
}
PROVISION_ERR="$(mktemp -t paratrooper-provision-err.XXXXXX)"
provision_status=0
run_provisioner &
provision_pid=$!
PROVISION_STARTED=yes
ACTIVE_CHILD_PID="$provision_pid"
spin_pid "$provision_pid" "Setting up your app on Render and waiting for it to go live."
wait_active_child || provision_status=$?
if [ "$provision_status" -ne 0 ]; then
	if [ -s "$PROVISION_ERR" ]; then
		cat "$PROVISION_ERR" >&2
	fi
	err ""
	err "⚠ Setup did not finish. Fix the problem above"
	err "  and run ./install.sh again."
	err "  Nothing is lost, and if your app was created,"
	err "  keep using the password you chose."
	exit 1
fi
cat "$PROVISION_ERR" >>"$LOG"

# Release the shell's copies as soon as provisioning has consumed them.
unset APP_PASSWORD CLAUDE_TOKEN RENDER_KEY provision_payload
WEB_URL="$(report_field web_url)"
DEPLOY_DETAIL="$(report_field deploy_detail)"
DEPLOYS_READY=no;   [ "$(report_field deploys_ready)" = "True" ] && DEPLOYS_READY=yes

# Readiness has two parts, and neither alone is enough: BOTH deploys must be live
# (the worker has no health endpoint of its own, so its deploy status is the only
# signal it started), and then the web must answer its health check.
READY=0
STATUS=""
if [ "$DEPLOYS_READY" = "yes" ]; then
	if [ -n "$WEB_URL" ] && wait_for_health "$WEB_URL"; then
		READY=1
	else
		STATUS="Everything is running, but the app has not answered yet."
	fi
else
	STATUS="${DEPLOY_DETAIL:-Your app is not running yet.}"
fi

# --- done ------------------------------------------------------------------

# Say "ready" only when both deploys are live AND the app answered. Anything else
# is created-but-unconfirmed: report it plainly, keep everything, exit non-zero.
if [ "$READY" = 1 ]; then
	printf '\n%s✦%s Paratrooper is ready!\n\n' "$GREEN" "$RESET"
else
	printf '\n%s⚠%s Your Paratrooper resources were created,\n' "$BOLD" "$RESET"
	printf '  but the deployment is not ready yet.\n'
	printf '\n'
	printf '%s' "$STATUS" | "$PY" -c '
import sys
from paratrooper.provision import wrap_installer_message
print(wrap_installer_message(sys.stdin.read(), first_prefix="  Status: ", later_prefix="          "))
'
	printf '\n'
fi

# The app address is the only sign-in detail displayed, including on failure.
if [ -n "$WEB_URL" ]; then
	printf '  %sApp address:%s  %s\n' "$BOLD" "$RESET" "$WEB_URL"
fi
printf '\n'

printf '%sOn your iPhone:%s\n\n' "$BOLD" "$RESET"
printf '  %s1.%s Open the app address above in Safari.\n\n' "$BOLD" "$RESET"
printf '  %s2.%s Add it to your Home Screen\n\n' "$BOLD" "$RESET"
printf '  %s3.%s Open Paratrooper from the Home Screen\n' "$BOLD" "$RESET"
printf '     and sign in with your app password.\n\n'
printf '  %s4.%s Allow notifications when Paratrooper asks.\n\n' "$BOLD" "$RESET"

# A created-but-unconfirmed deployment is an incomplete install: exit non-zero so
# a caller can tell, after pointing the way to finish. Nothing is removed.
if [ "$READY" != 1 ]; then
	printf '  Give it a few minutes, then check your app in the Render dashboard.\n'
	printf '  Run ./install.sh again to retry; nothing is created twice.\n'
	exit 1
fi
