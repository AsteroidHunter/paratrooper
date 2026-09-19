#!/usr/bin/env bash
# End-to-end offline tests for install.sh.
#
# Runs the real installer with uv, the Render CLI and Claude Code mocked on PATH,
# an isolated venv built with the fake uv from the packet's vendored dependencies
# (no network), the real paratrooper from source/src, the Render network mocked
# at the httpx boundary (mock_render_api via the PARATROOPER_PROVISION_MOCK seam),
# and the uv/CLI download boundaries mocked with installer hooks. No socket, no
# account, no real service, no real download.
#
# Flow: step 0 Python (uv), step 1 Render, step 2 Claude Code, step 3 idle
# sleeping, step 4 app password, then the unnumbered "Preparing your deployment"
# and "Provisioning on Render" sections.
#
# Exercised: the interactions and input order; step 0 building with uv present
# and with uv obtained through the hook after consent, declining or reaching EOF
# before uv installation, and a uv obtain failure stopping before any cloud
# creation; step 1 offering to install a missing Render CLI, with y
# (obtained through the hook or a mocked release ZIP) and n (stops before sign
# in, exit 0); step 2 offering to install a
# missing Claude Code, with y (installed, then found) and n (stops before sign
# in, exit 0); optional-key and skipped-key paths; cancellation; EOF at the idle
# choice; a failed Claude sign in and a Claude that hands back no token, both
# stopping with the one sign-in-failure message, setup-token run once, no token
# leaked; a Git-missing start-up stop whose message names no PARATROOPER_INSTALL_*
# variable while those variables still take effect everywhere else; a pre-provision
# validation gate failure stopping the unnumbered section; secret hiding; idempotent
# re-runs; partial-failure resume; create/response-lost password recovery; the
# per-resource and poll-by-poll provisioning progress kept in the install log and
# off the screen; readiness gated on BOTH the web and worker deploys plus the web
# health check, with failed/pending worker cases. Prints PASS/FAIL per scenario and
# exits non-zero if any fail.
set -u

VERIFY="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$VERIFY/../.." && pwd)"
DEPS="${PARATROOPER_INSTALL_TEST_DEPS:?point to an existing offline dependency directory}"
INSTALL="$SRC/install.sh"

if [ ! -d "$DEPS" ]; then
	echo "MISSING $DEPS (offline dependencies). Cannot run the e2e tests." >&2
	exit 3
fi
chmod +x "$VERIFY"/bin/* 2>/dev/null || true

REAL_PYTHON3="$(command -v python3)"   # captured before any PATH is curated
PROVISION_KEY="rnd_provisioning_key_E2E_AAAA"
IDLE_KEY="rnd_idle_key_E2E_ZZZZ"
CLAUDE_TOKEN="sk-ant-oat01-E2E-CLAUDE-000"
APP_PASSWORD="fake violet lantern orchard comet"
NEW_INPUT="yyn$APP_PASSWORD
$APP_PASSWORD"
WORKSPACE="tea-e2eworkspace000000001"
REPO_URL="https://github.com/example/paratrooper.git"

# One isolated venv, built by the first run from the vendored deps and reused by
# the rest (except the build scenarios below, which get their own fresh venv).
SHARED_VENV="$(mktemp -d -t ptp-venv.XXXXXX)"

# Installer hooks that stand in for the real download/install boundary. uv is the
# runtime boundary now: the uv hook drops the fake uv where install.sh expects
# the obtained binary; the fake uv then builds the venv with the python3 on PATH.
# The claude hook mimics the native installer, which places claude under
# ~/.local/bin. All are offline; none touch the network or a real installer.
HOOKS="$(mktemp -d -t ptp-hooks.XXXXXX)"
cat > "$HOOKS/uv_installer.sh" <<EOF
#!/usr/bin/env bash
: > "\$HOME/uv-installer-called"
cp "$VERIFY/bin/uv" "\$1"
EOF
cat > "$HOOKS/render_installer.sh" <<EOF
#!/usr/bin/env bash
cp "$VERIFY/bin/render" "\$1"
EOF
cat > "$HOOKS/claude_installer.sh" <<EOF
#!/usr/bin/env bash
mkdir -p "\$HOME/.local/bin"
cp "$VERIFY/bin/claude" "\$HOME/.local/bin/claude"
chmod +x "\$HOME/.local/bin/claude"
EOF
cat > "$HOOKS/fail_installer.sh" <<'EOF'
#!/usr/bin/env bash
echo "mock: obtaining the tool failed" >&2
exit 1
EOF
chmod +x "$HOOKS"/*.sh
python3 - "$VERIFY/bin/render" "$HOOKS/render-release.zip" <<'PY'
import sys
import zipfile
with zipfile.ZipFile(sys.argv[2], "w") as archive:
    archive.write(sys.argv[1], "cli_v2.28.0")
PY
printf 'not a ZIP archive\n' > "$HOOKS/invalid-release.zip"

# A curated bin dir with the tools install.sh needs, optionally excluding one, so
# a scenario can present a PATH with no uv, no render or no claude.
make_bin() {  # make_bin <dest> <exclude:python3|render|claude|uv|none>
	local dest="$1" exclude="$2" t src
	mkdir -p "$dest"
	for t in bash sh env mktemp rm mkdir rmdir chmod cat sleep awk tar unzip ln cp mv \
	         sed grep dirname basename stty uname date head tail true false tr sort; do
		src="$(command -v "$t" 2>/dev/null)" && [ -n "$src" ] && ln -sf "$src" "$dest/$t"
	done
	[ "$exclude" = python3 ] || ln -sf "$REAL_PYTHON3" "$dest/python3"
	for t in render claude curl uv; do
		[ "$exclude" = "$t" ] || ln -sf "$VERIFY/bin/$t" "$dest/$t"
	done
}
NOREN_BIN="$(mktemp -d -t ptp-noren.XXXXXX)";   make_bin "$NOREN_BIN" render
NOCLAUDE_BIN="$(mktemp -d -t ptp-nocla.XXXXXX)"; make_bin "$NOCLAUDE_BIN" claude
NOUV_BIN="$(mktemp -d -t ptp-nouv.XXXXXX)";      make_bin "$NOUV_BIN" uv
RENDER_RELEASE_BIN="$(mktemp -d -t ptp-render-release.XXXXXX)"; make_bin "$RENDER_RELEASE_BIN" render
rm "$RENDER_RELEASE_BIN/curl" "$RENDER_RELEASE_BIN/uname"
cat > "$RENDER_RELEASE_BIN/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in
    -s) printf '%s\n' "${MOCK_RELEASE_OS:-Darwin}" ;;
    -m) printf '%s\n' "${MOCK_RELEASE_ARCH:-arm64}" ;;
    *) /usr/bin/uname "$@" ;;
esac
EOF
cat > "$RENDER_RELEASE_BIN/curl" <<EOF
#!/usr/bin/env bash
if [ "\${2:-}" = https://api.github.com/repos/render-oss/cli/releases/latest ]; then
    [ "\${MOCK_RELEASE_FAIL:-}" = api ] && exit 22
    printf '{"tag_name":"%s"}\n' "\${MOCK_RELEASE_TAG:-v2.28.0}"
    exit 0
fi
if [[ "\${2:-}" == https://github.com/render-oss/cli/releases/download/* ]]; then
    printf '%s\n' "\$2" >> "\$MOCK_STATE_DIR/render_release.calls"
    expected="https://github.com/render-oss/cli/releases/download/v2.28.0/cli_2.28.0_\${MOCK_RELEASE_PLATFORM}_\${MOCK_RELEASE_CPU}.zip"
    [ "\$2" = "\$expected" ] || exit 22
    [ "\${MOCK_RELEASE_FAIL:-}" = download ] && exit 22
    cp "\${MOCK_RELEASE_ARCHIVE:-$HOOKS/render-release.zip}" "\$4"
    exit \$?
fi
exec "$VERIFY/bin/curl" "\$@"
EOF
chmod +x "$RENDER_RELEASE_BIN/uname" "$RENDER_RELEASE_BIN/curl"

FAILURES=0

# run <reuse:0|1> <name> <input> [ENV=VAL ...]
run() {
	local reuse="$1" input="$3"; shift 3
	HOMEDIR="$(mktemp -d -t ptp-home.XXXXXX)"
	LOGFILE="$HOMEDIR/.paratrooper-install.log"
	OUT="$(mktemp -t ptp-out.XXXXXX)"
	if [ "$reuse" != 1 ]; then
		STATE="$(mktemp -d -t ptp-state.XXXXXX)"
	fi
	(
		export HOME="$HOMEDIR"
		export PATH="$VERIFY/bin:$PATH"
		export PYTHONPATH="$VERIFY"                       # only the mock transport module
		export PARATROOPER_INSTALL_OFFLINE_DEPS="$DEPS"   # air-gapped: no pip network
		export PARATROOPER_INSTALL_VENV="$SHARED_VENV"
		export MOCK_STATE_DIR="$STATE"
		export PARATROOPER_PROVISION_MOCK=1
		export RENDER_API_KEY="$PROVISION_KEY"
		export RENDER_WORKSPACE="$WORKSPACE"
		export PARATROOPER_INSTALL_REPO_URL="$REPO_URL"
		export PARATROOPER_INSTALL_BRANCH="main"
		export MOCK_CLAUDE_TOKEN="$CLAUDE_TOKEN"
		export PARATROOPER_INSTALL_POLL_TRIES=3
		export PARATROOPER_INSTALL_POLL_INTERVAL=0
		export PARATROOPER_PROVISION_READY_TRIES=3
		export PARATROOPER_PROVISION_READY_INTERVAL=0
		local kv
		for kv in "$@"; do export "${kv?}"; done
		if [ -n "${MOCK_INITIAL_WORKSPACE:-}" ]; then
			mkdir -p "$HOME/.render"
			printf 'version: 1\nworkspace: %s\nworkspace_name: Saved Workspace\napi:\n  key: mock-cli-token\n' \
				"$MOCK_INITIAL_WORKSPACE" > "$HOME/.render/cli.yaml"
		fi
		printf '%s\n' "$input" | bash ${MOCK_BASH_FLAGS:-} "$INSTALL"
	) >"$OUT" 2>&1
	CODE=$?
    assert_absent "$OUT" "$APP_PASSWORD" "non_disclosure" "app password in output"
    [ ! -f "$LOGFILE" ] || assert_absent "$LOGFILE" "$APP_PASSWORD" "non_disclosure" "app password in log"
}

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s: %s\n' "$1" "$2"; FAILURES=$((FAILURES+1)); }
assert_contains() { grep -Fq -- "$2" "$1" || fail "$3" "expected to find: $4"; }
assert_absent()   { ! grep -Fq -- "$2" "$1" || fail "$3" "expected NOT to find: $4"; }

state_env() {
	python3 - "$1/api_state.json" "$2" "$3" <<'PY'
import json, os, sys
path, name, key = sys.argv[1], sys.argv[2], sys.argv[3]
value = ""
if os.path.exists(path):
    svc = json.load(open(path)).get("services", {}).get(name, {})
    value = svc.get("_envVars", {}).get(key, "")
print(value)
PY
}
state_count() {
	python3 - "$1/api_state.json" "$2" <<'PY'
import json, os, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    print(0); raise SystemExit
print(len(data.get(sys.argv[2], {})))
PY
}
writes_in_calls() {
	python3 - "$1/api_calls.jsonl" <<'PY'
import json, os, sys
path, n = sys.argv[1], 0
if os.path.exists(path):
    for line in open(path):
        line = line.strip()
        if line and json.loads(line)["method"] in ("POST", "PUT"):
            n += 1
print(n)
PY
}
read_workspaces() {
	python3 - "$1/api_calls.jsonl" <<'PY'
import json, os, sys
path = sys.argv[1]
owners = set()
if os.path.exists(path):
    for line in open(path):
        call = json.loads(line)
        if call["method"] == "GET" and call["path"] in ("/services", "/key-value"):
            owners.add(call.get("params", {}).get("ownerId", ""))
print(",".join(sorted(owners)))
PY
}
claude_calls() {
	python3 - "$1/claude.calls" <<'PY'
import os, sys
path = sys.argv[1]
print(sum(1 for _ in open(path)) if os.path.exists(path) else 0)
PY
}

# --- 1. happy path, idle sleeping off, both deploys live -------------------
run 0 happy_off "$NEW_INPUT"; NAME=happy_off; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE (expected 0)"
assert_contains "$OUT" "Local environment ready." $NAME "environment prepared"
assert_contains "$OUT" "Paratrooper is ready" $NAME "ready banner"
assert_contains "$OUT" "https://paratrooper-web.onrender.com" $NAME "app URL"
assert_absent "$STATE/render.calls" "render workspace set" $NAME "kept the selected workspace"
assert_contains "$OUT" "Render workspace: Test Workspace ($WORKSPACE)" $NAME "showed the active workspace"
assert_contains "$OUT" "Render workspace confirmed." $NAME "required confirmation"
# The per-resource progress no longer prints on screen; it lands in the install log.
assert_absent "$OUT" "created web paratrooper-web" $NAME "progress chatter on screen"
assert_contains "$LOGFILE" "created web paratrooper-web" $NAME "progress kept in log"
[ "$(state_count "$STATE" services)" = 2 ] || fail $NAME "expected 2 services"
[ "$APP_PASSWORD" = "$(state_env "$STATE" paratrooper-web PARATROOPER_APP_TOKEN)" ] || fail $NAME "selected password != provisioned"
assert_absent "$OUT" "$APP_PASSWORD" $NAME "password in output"
assert_absent "$LOGFILE" "$APP_PASSWORD" $NAME "password in log"
[ -n "$(state_env "$STATE" paratrooper-web VAPID_PUBLIC_KEY)" ] || fail $NAME "no VAPID public key"
[ "$(state_env "$STATE" paratrooper-web VAPID_SUBJECT)" = "https://paratrooper-web.onrender.com" ] || fail $NAME "VAPID subject not the app URL"
# Step 4 is one line now, printed unconditionally (no keys-not-configured variant).
assert_contains "$OUT" "Allow notifications when Paratrooper asks." $NAME "single step 4"
assert_absent "$OUT" "already configured" $NAME "old keys-configured wording"
assert_absent "$OUT" "were not configured this run" $NAME "keys-not-configured variant"
VAPID_PRIV="$(state_env "$STATE" paratrooper-web VAPID_PRIVATE_KEY)"
assert_absent "$OUT" "$CLAUDE_TOKEN" $NAME "claude token on stdout"
assert_absent "$LOGFILE" "$CLAUDE_TOKEN" $NAME "claude token in log"
assert_absent "$OUT" "$PROVISION_KEY" $NAME "provisioning key on stdout"
assert_absent "$OUT" "$VAPID_PRIV" $NAME "VAPID private key on stdout"
assert_absent "$LOGFILE" "$VAPID_PRIV" $NAME "VAPID private key in log"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 1b. fresh login requires a user-selected workspace --------------------
run 0 fresh_workspace "y2
yn$APP_PASSWORD
$APP_PASSWORD" MOCK_WORKSPACE_FRESH=1 RENDER_WORKSPACE=; NAME=fresh_workspace; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE (expected 0)"
assert_contains "$OUT" "Choose a Render workspace to continue." $NAME "offered workspace selection"
assert_contains "$OUT" "Select a workspace (1 or 2):" $NAME "ran the CLI picker"
assert_contains "$STATE/render.calls" "render workspace set" $NAME "invoked workspace selector"
assert_contains "$OUT" "Render workspace confirmed." $NAME "confirmed selection"
assert_contains "$HOMEDIR/.render/cli.yaml" "workspace: tea-second00000000000002" $NAME "saved the user's second choice"
assert_contains "$STATE/api_state.json" '"ownerId": "tea-second00000000000002"' $NAME "provisioned in the chosen workspace"
[ "$(read_workspaces "$STATE")" = tea-second00000000000002 ] || fail $NAME "inspected a different workspace"
[ "$(state_count "$STATE" services)" = 2 ] || fail $NAME "did not provision"
[ "$FAILURES" = "$FB" ] && pass $NAME

run 0 saved_workspace "$NEW_INPUT" MOCK_WORKSPACE_FRESH=1 MOCK_INITIAL_WORKSPACE=tea-saved000000000000001 RENDER_WORKSPACE=; NAME=saved_workspace; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE (expected 0)"
assert_absent "$STATE/render.calls" "render workspace set" $NAME "kept the saved workspace"
assert_contains "$OUT" "Render workspace: Saved Workspace (tea-saved000000000000001)" $NAME "showed the saved workspace"
assert_contains "$STATE/api_state.json" '"ownerId": "tea-saved000000000000001"' $NAME "provisioned in the saved workspace"
[ "$(read_workspaces "$STATE")" = tea-saved000000000000001 ] || fail $NAME "inspected a different workspace"
[ "$FAILURES" = "$FB" ] && pass $NAME

for choice in decline eof switch_cancel; do
	case "$choice" in
		decline) input="yn"; extra="MOCK_WORKSPACE_SET=interactive" ;;
		eof) input="y"; extra="MOCK_WORKSPACE_SET=interactive" ;;
		switch_cancel) input="ys"; extra="MOCK_WORKSPACE_SET=cancel" ;;
	esac
	run 0 "saved_workspace_$choice" "$input" MOCK_WORKSPACE_FRESH=1 MOCK_INITIAL_WORKSPACE=tea-saved000000000000001 RENDER_WORKSPACE= "$extra"
	NAME="saved_workspace_$choice"; FB=$FAILURES
	if [ "$choice" = decline ]; then
		[ "$CODE" = 0 ] || fail $NAME "expected a clean exit"
		assert_contains "$OUT" "Installation stopped before deployment." $NAME "declined the saved target"
	else
		[ "$CODE" != 0 ] || fail $NAME "expected cancellation"
	fi
	assert_contains "$OUT" "Render workspace: Saved Workspace (tea-saved000000000000001)" $NAME "showed the stale saved target"
	[ ! -e "$STATE/api_calls.jsonl" ] || fail $NAME "inspected app resources before confirmation"
	assert_absent "$OUT" "Claude Code token captured." $NAME "continued after cancellation"
	[ "$FAILURES" = "$FB" ] && pass $NAME
done

run 0 saved_workspace_switch "ys2
yn$APP_PASSWORD
$APP_PASSWORD" MOCK_WORKSPACE_FRESH=1 MOCK_INITIAL_WORKSPACE=tea-saved000000000000001 RENDER_WORKSPACE=tea-override00000000001; NAME=saved_workspace_switch; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE (expected 0)"
assert_contains "$OUT" "Render workspace: Selected Workspace (tea-override00000000001)" $NAME "showed the environment override"
assert_contains "$OUT" "Render workspace: Selected Workspace (tea-second00000000000002)" $NAME "showed the newly selected workspace"
assert_contains "$STATE/render.calls" "render workspace set" $NAME "opened the CLI picker"
[ "$(read_workspaces "$STATE")" = tea-second00000000000002 ] || fail $NAME "inspect or provision read outside the confirmed workspace"
assert_contains "$STATE/api_state.json" '"ownerId": "tea-second00000000000002"' $NAME "created resources in the confirmed workspace"
[ "$FAILURES" = "$FB" ] && pass $NAME

run 0 saved_workspace_same_switch "ys2
yn$APP_PASSWORD
$APP_PASSWORD" MOCK_WORKSPACE_FRESH=1 MOCK_INITIAL_WORKSPACE=tea-second00000000000002 RENDER_WORKSPACE=tea-override00000000001; NAME=saved_workspace_same_switch; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE (expected 0)"
assert_contains "$OUT" "Render workspace: Selected Workspace (tea-override00000000001)" $NAME "showed the override before switching"
assert_contains "$OUT" "Render workspace: Selected Workspace (tea-second00000000000002)" $NAME "confirmed the already-saved choice"
[ "$(read_workspaces "$STATE")" = tea-second00000000000002 ] || fail $NAME "read outside the confirmed saved workspace"
assert_contains "$STATE/api_state.json" '"ownerId": "tea-second00000000000002"' $NAME "created in the confirmed saved workspace"
[ "$FAILURES" = "$FB" ] && pass $NAME

# A canceled or empty picker must stop even when the CLI exits successfully.
for choice in cancel empty invalid; do
	case "$choice" in
		cancel) extra="MOCK_WORKSPACE_SET=cancel"; input="y" ;;
		empty) extra="MOCK_WORKSPACE_SET=empty"; input="y" ;;
		invalid) extra="MOCK_WORKSPACE_SET=interactive"; input="y0
" ;;
	esac
	run 0 "fresh_workspace_$choice" "$input" MOCK_WORKSPACE_FRESH=1 RENDER_WORKSPACE= "$extra"
	NAME="fresh_workspace_$choice"; FB=$FAILURES
	[ "$CODE" != 0 ] || fail $NAME "expected non-zero exit"
	assert_contains "$OUT" "No Render workspace was selected." $NAME "selection stopped cleanly"
	assert_contains "$STATE/render.calls" "render workspace set" $NAME "attempted workspace selection"
	assert_absent "$OUT" "Claude Code token captured." $NAME "stopped before Claude"
	[ ! -e "$STATE/api_calls.jsonl" ] || fail $NAME "inspected app resources without a workspace"
	[ "$(state_count "$STATE" services)" = 0 ] || fail $NAME "created services without a workspace"
	[ "$FAILURES" = "$FB" ] && pass $NAME
done

run 0 workspace_check_error "y" MOCK_WORKSPACE_CURRENT_ERROR=1; NAME=workspace_check_error; FB=$FAILURES
[ "$CODE" != 0 ] || fail $NAME "expected non-zero exit"
assert_contains "$OUT" "Could not check your Render workspace." $NAME "reported check failure"
assert_absent "$STATE/render.calls" "render workspace set" $NAME "did not change workspace after unrelated error"
[ ! -e "$STATE/api_calls.jsonl" ] || fail $NAME "inspected app resources after workspace check error"
[ "$(state_count "$STATE" services)" = 0 ] || fail $NAME "created services after check failure"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 2. idle sleeping on, keys stay distinct -------------------------------
run 0 idle_on "yyy$IDLE_KEY
$APP_PASSWORD
$APP_PASSWORD"; NAME=idle_on; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE (expected 0)"
[ "$(state_env "$STATE" paratrooper-web RENDER_API_KEY)" = "$IDLE_KEY" ] || fail $NAME "web missing idle key"
[ -n "$(state_env "$STATE" paratrooper-web RENDER_WORKER_SERVICE_ID)" ] || fail $NAME "web missing worker id"
assert_absent "$OUT" "$IDLE_KEY" $NAME "idle key on stdout"
assert_absent "$LOGFILE" "$IDLE_KEY" $NAME "idle key in log"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 3. cancel at the gate --------------------------------------------------
run 0 cancel "n"; NAME=cancel; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE (expected 0)"
assert_contains "$OUT" "No problem" $NAME "cancel message"
[ "$(state_count "$STATE" services)" = 0 ] || fail $NAME "created services after cancel"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 4. EOF at the idle choice cancels before provisioning ------------------
run 0 eof_idle "yy"; NAME=eof_idle; FB=$FAILURES
[ "$CODE" != 0 ] || fail $NAME "expected non-zero exit on EOF"
assert_contains "$OUT" "No answer, so nothing was set up" $NAME "EOF cancel message"
[ "$(state_count "$STATE" services)" = 0 ] || fail $NAME "provisioned despite EOF"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 5. failed Claude sign in runs setup-token once, leaks no token ---------
run 0 claude_fail "yy" MOCK_CLAUDE_FAIL=1; NAME=claude_fail; FB=$FAILURES
[ "$CODE" != 0 ] || fail $NAME "expected non-zero exit"
[ "$(claude_calls "$STATE")" = 1 ] || fail $NAME "setup-token ran $(claude_calls "$STATE") times, expected 1"
assert_absent "$OUT" "$CLAUDE_TOKEN" $NAME "token on stdout after failure"
assert_contains "$OUT" "Claude Code sign in did not complete" $NAME "single sign-in failure message"
[ "$(state_count "$STATE" services)" = 0 ] || fail $NAME "provisioned despite auth failure"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 5b. Claude hands back no token: the SAME single sign-in failure message -
run 0 claude_notoken "yy" MOCK_CLAUDE_TOKEN=; NAME=claude_notoken; FB=$FAILURES
[ "$CODE" != 0 ] || fail $NAME "expected non-zero exit"
assert_contains "$OUT" "Claude Code sign in did not complete" $NAME "same message on the no-token path"
[ "$(state_count "$STATE" services)" = 0 ] || fail $NAME "provisioned despite missing token"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 6. failed blueprint gate stops the unnumbered prepare section ----------
run 0 validate_fail "$NEW_INPUT" MOCK_BP_FAIL=1; NAME=validate_fail; FB=$FAILURES
[ "$CODE" != 0 ] || fail $NAME "expected non-zero exit"
assert_contains "$OUT" "Preparing your deployment" $NAME "reached prepare section"
assert_absent "$OUT" "5. Preparing your deployment" $NAME "prepare section still numbered"
assert_contains "$OUT" "Validating blueprint" $NAME "reached blueprint gate"
[ "$(writes_in_calls "$STATE")" = 0 ] || fail $NAME "provisioned despite validation failure"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 7. step 0: uv missing, obtained through the hook, then builds ----------
FRESHUV1="$(mktemp -d -t ptp-uv1.XXXXXX)"
run 0 no_uv "y$NEW_INPUT" PATH="$NOUV_BIN" PARATROOPER_INSTALL_UV_INSTALLER="$HOOKS/uv_installer.sh" PARATROOPER_INSTALL_VENV="$FRESHUV1"; NAME=no_uv; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE (expected 0)"
assert_contains "$OUT" "Download and install uv now?" $NAME "asked before obtaining uv"
[ -e "$HOMEDIR/uv-installer-called" ] || fail $NAME "did not invoke uv installer after consent"
assert_contains "$OUT" "uv ready." $NAME "obtained uv"
assert_contains "$OUT" "Local environment ready." $NAME "built the environment"
assert_contains "$OUT" "Paratrooper is ready" $NAME "proceeded to ready"
[ "$(state_count "$STATE" services)" = 2 ] || fail $NAME "did not provision"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 7b. missing uv, n or EOF never invokes the installer -------------------
FRESHUV_DECLINE="$(mktemp -d -t ptp-uv-decline.XXXXXX)"
run 0 no_uv_no "yn" PATH="$NOUV_BIN" PARATROOPER_INSTALL_UV_INSTALLER="$HOOKS/uv_installer.sh" PARATROOPER_INSTALL_VENV="$FRESHUV_DECLINE"; NAME=no_uv_decline; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE (expected 0 on decline)"
assert_contains "$OUT" "Download and install uv now?" $NAME "offered uv installation"
assert_contains "$OUT" "Install uv from" $NAME "manual installation guidance"
assert_absent "$OUT" "Obtaining uv" $NAME "did not start installation"
[ ! -e "$HOMEDIR/uv-installer-called" ] || fail $NAME "invoked uv installer after decline"
[ ! -e "$FRESHUV_DECLINE/bin/python" ] || fail $NAME "built environment after decline"
[ "$(state_count "$STATE" services)" = 0 ] || fail $NAME "created services after decline"
[ "$FAILURES" = "$FB" ] && pass $NAME

FRESHUV_EOF="$(mktemp -d -t ptp-uv-eof.XXXXXX)"
run 0 no_uv_eof "y" PATH="$NOUV_BIN" PARATROOPER_INSTALL_UV_INSTALLER="$HOOKS/uv_installer.sh" PARATROOPER_INSTALL_VENV="$FRESHUV_EOF"; NAME=no_uv_eof; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE (expected 0 on EOF)"
assert_contains "$OUT" "Download and install uv now?" $NAME "offered uv installation"
assert_contains "$OUT" "Install uv from" $NAME "manual installation guidance"
assert_absent "$OUT" "Obtaining uv" $NAME "did not start installation"
[ ! -e "$HOMEDIR/uv-installer-called" ] || fail $NAME "invoked uv installer after EOF"
[ ! -e "$FRESHUV_EOF/bin/python" ] || fail $NAME "built environment after EOF"
[ "$(state_count "$STATE" services)" = 0 ] || fail $NAME "created services after EOF"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 8. step 0: uv present, reused to build the environment -----------------
FRESHUV2="$(mktemp -d -t ptp-uv2.XXXXXX)"
run 0 uv_present "$NEW_INPUT" PARATROOPER_INSTALL_VENV="$FRESHUV2" PARATROOPER_INSTALL_UV_INSTALLER="$HOOKS/fail_installer.sh"; NAME=uv_present; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE (expected 0)"
assert_contains "$OUT" "uv found." $NAME "reused uv on PATH"
assert_absent "$OUT" "uv ready." $NAME "did not obtain uv when present"
assert_absent "$OUT" "Download and install uv now?" $NAME "did not ask when uv is present"
assert_contains "$OUT" "Local environment ready." $NAME "built the environment"
assert_contains "$OUT" "Paratrooper is ready" $NAME "proceeded to ready"
[ "$(state_count "$STATE" services)" = 2 ] || fail $NAME "did not provision"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 9. step 0: uv obtain failure stops before any cloud creation ----------
run 0 uv_fail "y$NEW_INPUT" PATH="$NOUV_BIN" PARATROOPER_INSTALL_UV_INSTALLER="$HOOKS/fail_installer.sh" PARATROOPER_INSTALL_VENV="$(mktemp -d -t ptp-uv3.XXXXXX)"; NAME=uv_fail; FB=$FAILURES
[ "$CODE" != 0 ] || fail $NAME "expected non-zero exit on uv obtain failure"
[ "$(state_count "$STATE" services)" = 0 ] || fail $NAME "created resources despite uv failure"
[ "$(state_count "$STATE" key_values)" = 0 ] || fail $NAME "created a store despite uv failure"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 10. step 1: Render CLI missing, y installs it, then signs in -----------
run 0 no_render "yyyn$APP_PASSWORD
$APP_PASSWORD" PATH="$NOREN_BIN" PARATROOPER_INSTALL_RENDER_INSTALLER="$HOOKS/render_installer.sh"; NAME=no_render; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE (expected 0)"
assert_contains "$OUT" "Download and install the Render CLI now?" $NAME "offered render install"
assert_contains "$OUT" "Render CLI ready." $NAME "obtained render"
assert_contains "$OUT" "Signed in to Render." $NAME "signed in after install"
assert_contains "$OUT" "Paratrooper is ready" $NAME "proceeded to ready"
[ "$(state_count "$STATE" services)" = 2 ] || fail $NAME "did not provision"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 10b. the real Render download path uses the official release ZIP ------
for spec in Darwin:arm64:darwin:arm64 Darwin:x86_64:darwin:amd64 Linux:aarch64:linux:arm64 Linux:x86_64:linux:amd64; do
	IFS=: read -r release_os release_arch release_platform release_cpu <<< "$spec"
	run 0 "render_release_${release_platform}_${release_cpu}" "yyyn$APP_PASSWORD
$APP_PASSWORD" PATH="$RENDER_RELEASE_BIN" MOCK_RELEASE_OS="$release_os" MOCK_RELEASE_ARCH="$release_arch" MOCK_RELEASE_PLATFORM="$release_platform" MOCK_RELEASE_CPU="$release_cpu"
	NAME="render_release_${release_platform}_${release_cpu}"; FB=$FAILURES
	[ "$CODE" = 0 ] || fail $NAME "exit $CODE (expected 0)"
	assert_contains "$STATE/render_release.calls" "https://github.com/render-oss/cli/releases/download/v2.28.0/cli_2.28.0_${release_platform}_${release_cpu}.zip" $NAME "official release asset URL"
	cmp -s "$HOMEDIR/.cache/paratrooper/bin/render" "$VERIFY/bin/render" || fail $NAME "did not extract the CLI binary"
	assert_contains "$OUT" "Signed in to Render." $NAME "continued after extracting CLI"
	[ "$(state_count "$STATE" services)" = 2 ] || fail $NAME "did not provision"
	[ "$FAILURES" = "$FB" ] && pass $NAME
done

for failure in api bad_tag download invalid_archive unsupported_arch; do
	case "$failure" in
		api) extra="MOCK_RELEASE_FAIL=api" ;;
		bad_tag) extra="MOCK_RELEASE_TAG=unexpected" ;;
		download) extra="MOCK_RELEASE_FAIL=download" ;;
		invalid_archive) extra="MOCK_RELEASE_ARCHIVE=$HOOKS/invalid-release.zip" ;;
		unsupported_arch) extra="MOCK_RELEASE_ARCH=riscv64" ;;
	esac
	run 0 "render_release_$failure" "yy" PATH="$RENDER_RELEASE_BIN" MOCK_RELEASE_PLATFORM=darwin MOCK_RELEASE_CPU=arm64 "$extra"
	NAME="render_release_$failure"; FB=$FAILURES
	[ "$CODE" != 0 ] || fail $NAME "expected non-zero exit"
	assert_contains "$OUT" "Obtaining the Render CLI ... failed" $NAME "reported download failure"
	[ ! -e "$HOMEDIR/.cache/paratrooper/bin/render" ] || fail $NAME "left a CLI binary after failure"
	[ "$(state_count "$STATE" services)" = 0 ] || fail $NAME "created services after failed download"
	[ "$FAILURES" = "$FB" ] && pass $NAME
done

# --- 11. step 1: Render CLI missing, n stops before sign in, exit 0 ---------
run 0 no_render_no "yn" PATH="$NOREN_BIN"; NAME=no_render_decline; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE (expected 0 on decline)"
assert_contains "$OUT" "Download and install the Render CLI now?" $NAME "offered render install"
assert_contains "$OUT" "Install the Render CLI from https://render.com/docs/cli" $NAME "manual link"
assert_absent "$OUT" "Signed in to Render." $NAME "did not sign in after decline"
[ "$(state_count "$STATE" services)" = 0 ] || fail $NAME "created services after decline"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 12. step 2: Claude Code missing, y installs it, then signs in ----------
run 0 no_claude "yyyn$APP_PASSWORD
$APP_PASSWORD" PATH="$NOCLAUDE_BIN" PARATROOPER_INSTALL_CLAUDE_INSTALLER="$HOOKS/claude_installer.sh"; NAME=no_claude; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE (expected 0)"
assert_contains "$OUT" "Download and install Claude Code now?" $NAME "offered claude install"
assert_contains "$OUT" "Claude Code installed." $NAME "installed claude"
assert_contains "$OUT" "Claude Code token captured." $NAME "signed in after install"
assert_contains "$OUT" "Paratrooper is ready" $NAME "proceeded to ready"
[ "$(state_count "$STATE" services)" = 2 ] || fail $NAME "did not provision"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 13. step 2: Claude Code missing, n stops before sign in, exit 0 --------
run 0 no_claude_no "yyn" PATH="$NOCLAUDE_BIN"; NAME=no_claude_decline; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE (expected 0 on decline)"
assert_contains "$OUT" "Download and install Claude Code now?" $NAME "offered claude install"
assert_contains "$OUT" "Install Claude Code from" $NAME "manual link"
assert_absent "$OUT" "Claude Code token captured." $NAME "did not sign in after decline"
[ "$(state_count "$STATE" services)" = 0 ] || fail $NAME "created services after decline"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 14. health never ready: accurate status, non-zero exit, nothing removed
run 0 health_timeout "$NEW_INPUT" MOCK_HEALTH_FAILS=999; NAME=health_timeout; FB=$FAILURES
[ "$CODE" != 0 ] || fail $NAME "expected non-zero exit on health timeout"
assert_contains "$OUT" "Status: Everything is running, but the app has not answered yet." $NAME "accurate timeout status"
assert_contains "$OUT" "not ready yet" $NAME "not-ready heading"
assert_absent "$OUT" "Paratrooper is ready!" $NAME "no false success"
[ "$(state_count "$STATE" services)" = 2 ] || fail $NAME "resources removed on timeout"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 15. worker deploy failed: not ready, named, nothing removed -----------
run 0 worker_failed "$NEW_INPUT" MOCK_DEPLOY_STATUS_WORKER=build_failed; NAME=worker_failed; FB=$FAILURES
[ "$CODE" != 0 ] || fail $NAME "expected non-zero exit on failed worker"
assert_absent "$OUT" "Paratrooper is ready!" $NAME "no false success"
assert_contains "$OUT" "Part of your app did not deploy" $NAME "reworded partial-failure status"
assert_contains "$OUT" "worker" $NAME "names the worker"
assert_contains "$OUT" "build_failed" $NAME "names the failure"
[ "$(state_count "$STATE" services)" = 2 ] || fail $NAME "resources removed on worker failure"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 16. worker deploy pending: unconfirmed, non-zero, nothing removed ------
run 0 worker_pending "$NEW_INPUT" MOCK_DEPLOY_STATUS_WORKER=build_in_progress; NAME=worker_pending; FB=$FAILURES
[ "$CODE" != 0 ] || fail $NAME "expected non-zero exit on pending worker"
assert_absent "$OUT" "Paratrooper is ready!" $NAME "no false success"
assert_contains "$OUT" "not ready yet" $NAME "unconfirmed status heading"
assert_contains "$OUT" "did not come up in time" $NAME "reworded timeout status"
# The poll-by-poll waiting lines are log-only now, never on screen.
assert_absent "$OUT" "waiting for the deploy to finish" $NAME "no wait chatter on screen"
assert_contains "$LOGFILE" "waiting for the deploy to finish" $NAME "wait chatter kept in log"
[ "$(state_count "$STATE" services)" = 2 ] || fail $NAME "resources removed on pending worker"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 17. idempotent re-run recovers the live password ----------------------
run 0 rerun_first "$NEW_INPUT"; NAME=rerun; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "first run exit $CODE"
KEEP="$STATE"
LIVE_PW="$(state_env "$KEEP" paratrooper-web PARATROOPER_APP_TOKEN)"
rm -f "$KEEP/api_calls.jsonl"
run 1 rerun_second "yyny" PATH="$NOUV_BIN" PARATROOPER_INSTALL_UV_INSTALLER="$HOOKS/fail_installer.sh"
[ "$CODE" = 0 ] || fail $NAME "second run exit $CODE"
assert_absent "$OUT" "Download and install uv now?" $NAME "reused environment without uv"
assert_absent "$OUT" "reused web paratrooper-web" $NAME "progress chatter on screen"
assert_contains "$LOGFILE" "reused web paratrooper-web" $NAME "web reused (in log)"
[ "$(state_env "$KEEP" paratrooper-web PARATROOPER_APP_TOKEN)" = "$LIVE_PW" ] || fail $NAME "re-run changed the live password"
assert_absent "$OUT" "$LIVE_PW" $NAME "existing password in output"
assert_absent "$OUT" "App password (input hidden):" $NAME "asked for an unused password"
assert_contains "$OUT" "Continue keeping the existing app password?" $NAME "explicit reuse confirmation"
[ "$(writes_in_calls "$KEEP")" = 0 ] || fail $NAME "second run created or wrote resources"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 18. create succeeded, response lost: rerun delivers stored password ----
run 0 lost_first "$NEW_INPUT" MOCK_API_LOSE_RESPONSE=paratrooper-web; NAME=response_lost; FB=$FAILURES
[ "$CODE" != 0 ] || fail $NAME "expected first run to fail on the lost response"
KEEP="$STATE"
STORED_PW="$(state_env "$KEEP" paratrooper-web PARATROOPER_APP_TOKEN)"
[ -n "$STORED_PW" ] || fail $NAME "web not created on the server before the lost response"
run 1 lost_second "yyny"
[ "$CODE" = 0 ] || fail $NAME "resume run exit $CODE"
assert_absent "$OUT" "reused web paratrooper-web" $NAME "progress chatter on screen"
assert_contains "$LOGFILE" "reused web paratrooper-web" $NAME "web reused on resume (in log)"
[ "$(state_env "$KEEP" paratrooper-web PARATROOPER_APP_TOKEN)" = "$STORED_PW" ] || fail $NAME "resume changed the stored password"
assert_absent "$OUT" "$STORED_PW" $NAME "stored password in output"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 19. partial failure then resume ---------------------------------------
run 0 partial_fail "$NEW_INPUT" MOCK_API_FAIL_SERVICE=paratrooper-web; NAME=partial_resume; FB=$FAILURES
[ "$CODE" != 0 ] || fail $NAME "expected first run to fail"
assert_contains "$OUT" "run ./install.sh again" $NAME "resume guidance"
# The provisioner's own "error:" line is held off the spinner but still reaches the
# screen on a failure, above the guidance (it is the "problem above" that is referenced).
assert_contains "$OUT" "error:" $NAME "provisioner error line kept on screen"
[ "$(state_count "$STATE" services)" = 1 ] || fail $NAME "worker not created before failure"
run 1 partial_resume "$NEW_INPUT"
[ "$CODE" = 0 ] || fail $NAME "resume run exit $CODE"
[ "$(state_count "$STATE" services)" = 2 ] || fail $NAME "web not created on resume"
assert_absent "$OUT" "created web paratrooper-web" $NAME "progress chatter on screen"
assert_contains "$LOGFILE" "created web paratrooper-web" $NAME "web created on resume (in log)"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- 20. Git missing at start-up: shorter message, no variable names --------
# The repository URL/branch env vars still take effect everywhere else (every
# scenario above relies on them); here they are cleared and Git is off PATH, so
# the start-up resolution needs Git, cannot find it, and stops with the reworded
# message that no longer names the PARATROOPER_INSTALL_* variables.
run 0 git_missing "y" PATH="$NOUV_BIN" PARATROOPER_INSTALL_REPO_URL= PARATROOPER_INSTALL_BRANCH=; NAME=git_missing; FB=$FAILURES
[ "$CODE" != 0 ] || fail $NAME "expected non-zero exit when Git is missing"
assert_contains "$OUT" "Paratrooper needs Git, but it is not installed." $NAME "reworded Git-missing message"
assert_absent "$OUT" "PARATROOPER_INSTALL_REPO_URL" $NAME "no variable name in Git message"
assert_absent "$OUT" "PARATROOPER_INSTALL_BRANCH" $NAME "no variable name in Git message"
[ "$(state_count "$STATE" services)" = 0 ] || fail $NAME "created resources despite missing Git"
[ "$FAILURES" = "$FB" ] && pass $NAME

# --- Password entry and explicit reuse regressions -------------------------
run 0 mismatch "yyn$APP_PASSWORD
different fake confirmation words
$APP_PASSWORD
$APP_PASSWORD"; NAME=mismatch; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE"
assert_contains "$OUT" "did not match" $NAME "mismatch message"
assert_absent "$OUT" "different fake confirmation words" $NAME "confirmation in output"
[ "$(state_env "$STATE" paratrooper-web PARATROOPER_APP_TOKEN)" = "$APP_PASSWORD" ] || fail $NAME "selected password not stored"
[ "$FAILURES" = "$FB" ] && pass $NAME

run 0 blank_then_valid "yyn
$APP_PASSWORD
$APP_PASSWORD"; NAME=blank_then_valid; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE"
assert_contains "$OUT" "That was empty" $NAME "blank rejected"
[ "$FAILURES" = "$FB" ] && pass $NAME

run 0 eof_password "yyn"; NAME=eof_password; FB=$FAILURES
[ "$CODE" != 0 ] || fail $NAME "expected cancellation"
assert_contains "$OUT" "No password, so nothing was set up" $NAME "EOF canceled"
[ "$(writes_in_calls "$STATE")" = 0 ] || fail $NAME "write before password confirmation"
[ "$FAILURES" = "$FB" ] && pass $NAME

run 0 eof_confirmation "yyn$APP_PASSWORD"; NAME=eof_confirmation; FB=$FAILURES
[ "$CODE" != 0 ] || fail $NAME "expected cancellation"
assert_contains "$OUT" "No password, so nothing was set up" $NAME "EOF at confirmation canceled"
[ "$(writes_in_calls "$STATE")" = 0 ] || fail $NAME "write before password confirmation"
[ "$FAILURES" = "$FB" ] && pass $NAME

run 0 debug_flags "$NEW_INPUT" MOCK_BASH_FLAGS=-xva APP_PASSWORD=caller-export-marker; NAME=debug_flags; FB=$FAILURES
[ "$CODE" = 0 ] || fail $NAME "exit $CODE"
[ "$(state_env "$STATE" paratrooper-web PARATROOPER_APP_TOKEN)" = "$APP_PASSWORD" ] || fail $NAME "selected password not stored"
[ "$FAILURES" = "$FB" ] && pass $NAME

# The previous run provides an existing app. Canceling or EOF at the deliberate
# keep step must write nothing and must not ask for a fresh password.
rm -f "$STATE/api_calls.jsonl"
run 1 cancel_existing "yynn"; NAME=cancel_existing; FB=$FAILURES
[ "$CODE" != 0 ] || fail $NAME "expected cancellation"
assert_contains "$OUT" "No resources or passwords were changed" $NAME "cancellation message"
assert_absent "$OUT" "App password (input hidden):" $NAME "unneeded password prompt"
[ "$(writes_in_calls "$STATE")" = 0 ] || fail $NAME "write after cancel"
[ "$FAILURES" = "$FB" ] && pass $NAME

run 1 eof_existing "yyn"; NAME=eof_existing; FB=$FAILURES
[ "$CODE" != 0 ] || fail $NAME "expected cancellation"
[ "$(writes_in_calls "$STATE")" = 0 ] || fail $NAME "write after EOF"
[ "$FAILURES" = "$FB" ] && pass $NAME

echo
if [ "$FAILURES" = 0 ]; then
	echo "all install.sh scenarios passed"
	exit 0
fi
echo "$FAILURES assertion(s) failed"
exit 1
