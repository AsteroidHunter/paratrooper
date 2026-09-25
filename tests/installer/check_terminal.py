#!/usr/bin/env python3
"""Exercise the real installer in a pseudo-terminal with fake CLIs and no sockets.

Run with PARATROOPER_INSTALL_TEST_DEPS pointing to an offline dependency directory.
A private scratch source copy keeps the installer's generated config out of the
checkout. No provider credentials or personal configuration are loaded.
"""
from __future__ import annotations

import fcntl
import json
import os
import pty
import re
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).resolve().parent
PASSWORD = "fake violet lantern = $() `comet` \\ orchard 7"
WRONG = "different fake confirmation words"
# Fake Claude tokens with the real shape and length. FIXTURE_TOKEN is what the
# fake setup-token prints; PASTED_TOKEN is typed at the hidden paste prompt;
# OTHER_TOKEN is a second, different token on the screen or a token Claude
# should refuse.
FIXTURE_TOKEN = "sk-ant-oat01-fake-claude-fixture-token_0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUV-fixAA"
PASTED_TOKEN = "sk-ant-oat01-fake-pasted-fixture-token_9876543210zyxwvutsrqponmlkjihgfedcba-ZYXWVUTSRQPONMLKJIHG-pasteAA"
OTHER_TOKEN = "sk-ant-oat01-fake-other-fixture-token_1357924680acegikmoqsuwybdfhjlnprtvxz-ACEGIKMOQSUWYBDFHJLN-otherAA"
RUN = Path(tempfile.mkdtemp(prefix="ptp-password-terminal-"))
SOURCE = RUN / "source"
SOURCE.mkdir()
for name in ("install.sh", "render.yaml", "pyproject.toml"):
    shutil.copy2(PROJECT / name, SOURCE / name)
shutil.copytree(PROJECT / "src", SOURCE / "src", ignore=shutil.ignore_patterns("__pycache__"))
DEPS = Path(os.environ["PARATROOPER_INSTALL_TEST_DEPS"]).resolve()
assert DEPS.is_dir()

# Every Python child runs real application libraries with sockets blocked. Capture
# argv and only the shell secret-variable names to catch accidental export. Fake
# API request bodies are separate test state, not installer output or logs.
ENTRY = RUN / "python_entry.py"
ENTRY.write_text('''import json, os, runpy, socket, sys
from pathlib import Path
def blocked(*a, **kw):
    raise RuntimeError("offline terminal fixture blocked a socket attempt")
socket.socket.connect = blocked
socket.socket.connect_ex = blocked
socket.create_connection = blocked
socket.getaddrinfo = blocked
state = Path(os.environ["MOCK_STATE_DIR"])
with (state / "process.jsonl").open("a") as handle:
    handle.write(json.dumps({"argv": sys.argv[1:], "env": {key: os.environ[key]
        for key in ("APP_PASSWORD", "value", "confirmation", "provision_payload", "CLAUDE_TOKEN", "RENDER_KEY")
        if key in os.environ}}) + "\\n")
''' + f'sys.path[:0] = {list(map(str, (DEPS, SOURCE / "src", FIXTURES)))!r}\n' + '''
args = sys.argv[1:]
if args[0] == "-c":
    sys.argv = ["-c"] + args[2:]
    exec(compile(args[1], "<string>", "exec"), {"__name__": "__main__"})
elif args[0] == "-":
    sys.argv = args
    exec(compile(sys.stdin.read(), "<stdin>", "exec"), {"__name__": "__main__"})
elif args[0] == "-m":
    sys.argv = args[1:]
    runpy.run_module(args[1], run_name="__main__", alter_sys=True)
else:
    raise RuntimeError("unexpected Python invocation in offline fixture")
''')
BIN = RUN / "bin"
BIN.mkdir()
wrapper = "#!/bin/bash\nexec " + " ".join(map(shlex.quote, (
    sys.executable, "-B", "-P", "-S", str(ENTRY)))) + ' "$@"\n'
for name in ("python", "python3"):
    (BIN / name).write_text(wrapper)
    (BIN / name).chmod(0o755)
# Observe the process spawned immediately after each hidden read, where a local
# shell variable could leak if it inherited the caller's export attribute.
(BIN / "stty").write_text(
    "#!/bin/bash\n" + shlex.quote(str(BIN / "python")) + " -c 'pass'\nexec "
    + shlex.quote(shutil.which("stty")) + ' "$@"\n'
)
(BIN / "stty").chmod(0o755)
# The sandbox cannot enumerate system processes with ps. Supply only the
# fixture's recorded child-parent pairs, so the installer's recursive cleanup
# still runs against real test PIDs without seeing or signaling anyone else.
if os.environ.get("PARATROOPER_INSTALL_TEST_REAL_PS") != "1":
    (BIN / "ps").write_text('''#!/bin/bash
for stem in api_wait claude_helper claude_check; do
    pid="$MOCK_STATE_DIR/$stem.pid"
    parent="$MOCK_STATE_DIR/$stem.ppid"
    if [ -f "$pid" ] && [ -f "$parent" ]; then
        printf '%s %s\\n' "$(cat "$pid")" "$(cat "$parent")"
    fi
done
''')
    (BIN / "ps").chmod(0o755)
# Looks ready to the installer and uses the guarded interpreter above.
VENV = RUN / "venv"
VENV.mkdir()
(VENV / "bin").symlink_to(BIN, target_is_directory=True)


class TerminalRun:
    def __init__(self, name, *, state=None, extra=None):
        self.case = RUN / name
        self.case.mkdir()
        (self.case / "home").mkdir()
        self.state = state or self.case / "state"
        self.state.mkdir(exist_ok=True)
        env = {
            "HOME": str(self.case / "home"),
            "PATH": f"{BIN}:{FIXTURES / 'bin'}:/usr/bin:/bin",
            "TMPDIR": str(self.case), "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
            "OPENSSL_CONF": "/dev/null", "MOCK_STATE_DIR": str(self.state),
            "PARATROOPER_PROVISION_MOCK": "1", "RENDER_API_KEY": "fake-render-fixture-key",
            "RENDER_WORKSPACE": "tea-terminal-fixture", "MOCK_CLAUDE_TOKEN": FIXTURE_TOKEN,
            "PARATROOPER_INSTALL_VENV": str(VENV), "PARATROOPER_INSTALL_OFFLINE_DEPS": str(DEPS),
            "PARATROOPER_INSTALL_REPO_URL": "https://github.com/example/paratrooper.git",
            "PARATROOPER_INSTALL_BRANCH": "fixture", "PARATROOPER_INSTALL_POLL_TRIES": "1",
            "PARATROOPER_INSTALL_POLL_INTERVAL": "0", "PARATROOPER_PROVISION_READY_TRIES": "2",
            "PARATROOPER_PROVISION_READY_INTERVAL": "0",
            # Deliberately exported by the caller. The installer must remove these
            # attributes before assigning any input, including under bash -a.
            "APP_PASSWORD": "caller-export-marker", "provision_payload": "caller-export-marker",
            "CLAUDE_TOKEN": "caller-export-marker", "RENDER_KEY": "caller-export-marker",
            "value": "caller-export-marker", "confirmation": "caller-export-marker",
        }
        env.update(extra or {})
        self.master, self.slave = pty.openpty()
        self.original = termios.tcgetattr(self.slave)
        self.output = b""
        self.cursor = 0

        def controlling_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        self.proc = subprocess.Popen(
            ["/bin/bash", "-xva", str(SOURCE / "install.sh")], env=env,
            stdin=self.slave, stdout=self.slave, stderr=self.slave,
            preexec_fn=controlling_terminal,
        )

    def read(self):
        if select.select([self.master], [], [], 0.05)[0]:
            try:
                self.output += os.read(self.master, 65536)
            except OSError:
                pass

    def expect(self, value):
        target = value.encode()
        deadline = time.monotonic() + 20
        while target not in self.output[self.cursor:]:
            if time.monotonic() >= deadline or self.proc.poll() is not None:
                raise AssertionError(f"{self.case.name}: did not reach prompt {value!r}")
            self.read()
        self.cursor = self.output.index(target, self.cursor) + len(target)

    def send(self, value):
        os.write(self.master, value.encode())

    def hidden(self, prompt, value):
        self.expect(prompt)
        assert not termios.tcgetattr(self.slave)[3] & termios.ECHO, "input echo was enabled"
        # No mutating API call may precede password confirmation.
        calls = self.state / "api_calls.jsonl"
        if calls.exists():
            assert not any(json.loads(line)["method"] in ("POST", "PUT")
                           for line in calls.read_text().splitlines())
        self.send(value)

    def begin(self):
        self.expect("Ready to begin? (y / n) ")
        self.send("y")
        self.expect("Use this workspace for Paratrooper? (y / s / n) ")
        self.send("y")
        self.expect("answer: ")
        self.send("n")

    def finish(self, expected):
        deadline = time.monotonic() + 25
        while self.proc.poll() is None:
            if time.monotonic() >= deadline:
                self.proc.kill()
                raise AssertionError(f"{self.case.name}: installer did not terminate")
            self.read()
        for _ in range(3):
            self.read()
        assert self.proc.returncode == expected, (self.case.name, self.proc.returncode,
                                                 self.output[-1500:].decode(errors="replace"))
        # macOS detaches the slave when its controlling session exits. The
        # still-open master retains the settings and supports this assertion.
        current = termios.tcgetattr(self.master)
        assert current == self.original, (
            "terminal settings not restored", current[3], self.original[3],
            self.output[-400:].decode(errors="replace"),
        )
        os.close(self.master)
        os.close(self.slave)
        output = self.output.decode(errors="replace")
        (self.case / "output.txt").write_text(output)
        log = (self.case / "home" / ".paratrooper-install.log").read_text()
        processes = (self.state / "process.jsonl").read_text()
        for secret in (PASSWORD, WRONG, "fake-render-fixture-key", FIXTURE_TOKEN, PASTED_TOKEN,
                       OTHER_TOKEN, "fixture-token_"):
            assert secret not in output + log + processes, "secret appeared in output/log/argv/env"
        # Non-secret caller values may persist until their local input helper is
        # entered. No caller-exported name may contain newly entered input.
        assert all(value == "caller-export-marker"
                   for line in processes.splitlines()
                   for value in json.loads(line)["env"].values())
        # Neither a private secret output file nor a surviving report is needed.
        assert not list(self.case.glob("paratrooper-*"))
        print("PASS terminal " + self.case.name, flush=True)
        return output


def screen(output):
    """The text a terminal shows: colors dropped, erased spinner lines applied."""
    output = re.sub(r"\x1b\[[0-9;]*m", "", output)
    lines, line, col = [], [], 0
    for part in re.split(r"(\x1b\[K|\r|\n)", output):
        if part == "\x1b[K":
            del line[col:]
        elif part == "\r":
            col = 0
        elif part == "\n":
            lines.append("".join(line))
            line, col = [], 0
        else:
            for ch in part:
                line[col:col + 1] = [ch]
                col += 1
    return "\n".join(lines + ["".join(line)])


def assert_layout(output):
    """Below the configuration check: never two blank lines in a row, no indented
    line, and every warning, result, error or question starts its own block
    after a blank line."""
    text = screen(output)
    lines = text[text.index("✓ Configuration is valid."):].splitlines()
    for before, line in zip(lines, lines[1:]):
        assert line.strip() or before.strip(), ("two blank lines in a row", text)
        assert not (line[:1].isspace() and line.strip()), ("indented line", line)
        assert not line.startswith(("⚠", "✦", "error:", "Status:", "Continue without")) or not before.strip(), (
            "no blank line before", line)


def assert_stopped(path):
    pid = int(path.read_text())
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return
    raise AssertionError(f"installer child {pid} survived Ctrl-C")


def exercise():
    fresh = TerminalRun("fresh-workspace", extra={"RENDER_WORKSPACE": "", "MOCK_WORKSPACE_FRESH": "1"})
    fresh.expect("Ready to begin? (y / n) ")
    fresh.send("y")
    fresh.expect("Select a workspace (1 or 2): ")
    fresh.send("2\n")
    fresh.expect("Use this workspace for Paratrooper? (y / s / n) ")
    fresh.send("y")
    fresh.expect("answer: ")
    fresh.send("n")
    fresh.expect("Use at least 11 characters, with a letter, a number and a symbol.")
    fresh.hidden("App password (input hidden): ", PASSWORD + "\n")
    fresh.hidden("Confirm app password (input hidden): ", PASSWORD + "\n")
    output = fresh.finish(0)
    assert "Render workspace confirmed." in output
    assert "render workspace set" in (fresh.state / "render.calls").read_text()
    state = json.loads((fresh.state / "api_state.json").read_text())
    assert state["services"]["paratrooper-web"]["ownerId"] == "tea-second00000000000002"

    workspace_cancel = TerminalRun("workspace-ctrl-c")
    workspace_cancel.expect("Ready to begin? (y / n) ")
    workspace_cancel.send("y")
    workspace_cancel.expect("  n - stop here\r\n\r\n")
    workspace_cancel.expect("Use this workspace for Paratrooper? (y / s / n) ")
    # The trace prints the prompt text before the live read; let that read start.
    time.sleep(0.3)
    workspace_cancel.send("\x03")
    workspace_cancel.finish(130)
    assert not (workspace_cancel.state / "api_calls.jsonl").exists()

    # A browser authorization may leave the CLI waiting indefinitely. Ctrl-C
    # must interrupt the parent even then, without closing unrelated sessions.
    other = subprocess.Popen(["/bin/sleep", "120"], start_new_session=True)
    try:
        login_cancel = TerminalRun("render-login-ctrl-c", extra={"MOCK_RENDER_LOGIN_WAIT": "1"})
        login_cancel.expect("Ready to begin? (y / n) ")
        login_cancel.send("y")
        login_cancel.expect("mock render login waiting")
        login_cancel.send("\x03")
        login_cancel.finish(130)
        assert_stopped(login_cancel.state / "render_login_wait.pid")
        assert other.poll() is None, "unrelated session was stopped"

        claude_cancel = TerminalRun("claude-browser-ctrl-c", extra={"MOCK_CLAUDE_NESTED_WAIT": "1"})
        claude_cancel.expect("Ready to begin? (y / n) ")
        claude_cancel.send("y")
        claude_cancel.expect("Use this workspace for Paratrooper? (y / s / n) ")
        claude_cancel.send("y")
        claude_cancel.expect("mock Claude browser opened")
        claude_cancel.send("\x03")
        claude_cancel.finish(130)
        assert_stopped(claude_cancel.state / "claude_wait.pid")
        assert_stopped(claude_cancel.state / "claude_helper.pid")
        assert other.poll() is None, "unrelated session was stopped"
    finally:
        other.terminate()
        other.wait(timeout=5)

    blueprint_cancel = TerminalRun(
        "blueprint-ctrl-c", extra={"MOCK_BP_WAIT": "1", "MOCK_BP_IGNORE_TERM": "1"}
    )
    blueprint_cancel.begin()
    blueprint_cancel.hidden("App password (input hidden): ", PASSWORD + "\n")
    blueprint_cancel.hidden("Confirm app password (input hidden): ", PASSWORD + "\n")
    blueprint_cancel.expect("Validating blueprint ...")
    deadline = time.monotonic() + 10
    while not (blueprint_cancel.state / "blueprint_wait.pid").exists():
        assert time.monotonic() < deadline, "Blueprint validation did not reach mock wait"
        blueprint_cancel.read()
    blueprint_cancel.send("\x03")
    blueprint_cancel.finish(130)
    assert_stopped(blueprint_cancel.state / "blueprint_wait.pid")
    assert not any(
        json.loads(line)["method"] in ("POST", "PUT")
        for line in (blueprint_cancel.state / "api_calls.jsonl").read_text().splitlines()
    )

    # Only a Cloudflare block, and only a deliberate terminal answer, permits
    # continuing past this optional preflight. A normal invalid Blueprint does
    # not offer that choice.
    blocked_no = TerminalRun("cloudflare-decline", extra={"MOCK_BP_CLOUDFLARE": "1"})
    blocked_no.begin()
    blocked_no.hidden("App password (input hidden): ", PASSWORD + "\n")
    blocked_no.hidden("Confirm app password (input hidden): ", PASSWORD + "\n")
    blocked_no.expect("Continue without Render's preflight check? (y / n) ")
    blocked_no.send("n")
    assert_layout(blocked_no.finish(1))
    assert not any(json.loads(line)["method"] in ("POST", "PUT")
                   for line in (blocked_no.state / "api_calls.jsonl").read_text().splitlines())

    blocked_yes = TerminalRun("cloudflare-continue", extra={"MOCK_BP_CLOUDFLARE": "1"})
    blocked_yes.begin()
    blocked_yes.hidden("App password (input hidden): ", PASSWORD + "\n")
    blocked_yes.hidden("Confirm app password (input hidden): ", PASSWORD + "\n")
    blocked_yes.expect("Continue without Render's preflight check? (y / n) ")
    blocked_yes.send("y")
    output = blocked_yes.finish(0)
    assert "Blueprint is valid." not in output
    assert "Continuing without Render's Blueprint preflight." in output
    assert (blocked_yes.state / "api_state.json").exists()
    assert_layout(output)

    # The reported path: continue past the block, then Render refuses a create.
    blocked_error = TerminalRun(
        "cloudflare-continue-api-error", extra={"MOCK_BP_CLOUDFLARE": "1", "MOCK_API_FAIL_KV": "1"}
    )
    blocked_error.begin()
    blocked_error.hidden("App password (input hidden): ", PASSWORD + "\n")
    blocked_error.hidden("Confirm app password (input hidden): ", PASSWORD + "\n")
    blocked_error.expect("Continue without Render's preflight check? (y / n) ")
    blocked_error.send("y")
    output = blocked_error.finish(1)
    assert "error: Render API POST /key-value answered 500" in output
    assert_layout(output)

    invalid = TerminalRun("invalid-blueprint", extra={"MOCK_BP_FAIL": "1"})
    invalid.begin()
    invalid.hidden("App password (input hidden): ", PASSWORD + "\n")
    invalid.hidden("Confirm app password (input hidden): ", PASSWORD + "\n")
    output = invalid.finish(1)
    assert "Continue without Render's preflight check?" not in output
    assert_layout(output)

    forbidden = TerminalRun("permission-403", extra={"MOCK_BP_FORBIDDEN": "1"})
    forbidden.begin()
    forbidden.hidden("App password (input hidden): ", PASSWORD + "\n")
    forbidden.hidden("Confirm app password (input hidden): ", PASSWORD + "\n")
    output = forbidden.finish(1)
    assert "Continue without Render's preflight check?" not in output
    assert_layout(output)

    provision_cancel = TerminalRun(
        "provision-ctrl-c", extra={"MOCK_API_WAIT_ON": "POST /key-value"}
    )
    provision_cancel.begin()
    provision_cancel.hidden("App password (input hidden): ", PASSWORD + "\n")
    provision_cancel.hidden("Confirm app password (input hidden): ", PASSWORD + "\n")
    provision_cancel.expect("Setting up your app on Render and waiting for it to go live.")
    deadline = time.monotonic() + 10
    while not (provision_cancel.state / "api_wait.pid").exists():
        assert time.monotonic() < deadline, "provisioning did not reach mock wait"
        provision_cancel.read()
    provision_cancel.send("\x03")
    output = provision_cancel.finish(130)
    assert_stopped(provision_cancel.state / "api_wait.pid")
    assert "Any Render resources already created were kept" in output

    run = TerminalRun("new-mismatch-blank-success")
    run.begin()
    run.hidden("App password (input hidden): ", "\n")
    run.expect("That was empty")
    run.hidden("App password (input hidden): ", PASSWORD + "\n")
    run.hidden("Confirm app password (input hidden): ", WRONG + "\n")
    run.expect("did not match")
    run.hidden("App password (input hidden): ", PASSWORD + "\n")
    run.hidden("Confirm app password (input hidden): ", PASSWORD + "\n")
    output = run.finish(0)
    assert "Paratrooper is ready!" in output and "App address:" in output
    assert_layout(output)
    # The per-resource progress is log-only now; the screen shows the single step 4.
    log = (run.case / "home" / ".paratrooper-install.log").read_text()
    assert "created web paratrooper-web" not in output, "progress chatter reached the screen"
    assert "created web paratrooper-web" in log, "progress not kept in the log"
    assert "Allow notifications when prompted" in output, "single step 4 missing"
    assert "already configured" not in output, "old keys-configured wording still shown"
    state = json.loads((run.state / "api_state.json").read_text())
    assert state["services"]["paratrooper-web"]["_envVars"]["PARATROOPER_APP_TOKEN"] == PASSWORD
    prior = state["services"]["paratrooper-web"]["_envVars"]
    (run.state / "process.jsonl").unlink()
    (run.state / "api_calls.jsonl").unlink()
    resume = TerminalRun("existing-keeps-password", state=run.state)
    resume.begin()
    resume.expect("Continue keeping the existing app password? (y / n) ")
    resume.send("y")
    output = resume.finish(0)
    assert "App password (input hidden):" not in output
    state = json.loads((run.state / "api_state.json").read_text())
    assert state["services"]["paratrooper-web"]["_envVars"] == prior
    assert not any(json.loads(line)["method"] in ("POST", "PUT")
                   for line in (run.state / "api_calls.jsonl").read_text().splitlines())

    for name, confirm, cancel in (("ctrl-c-first", False, "\x03"),
                                  ("ctrl-c-confirm", True, "\x03"),
                                  ("eof-first", False, "\x04"),
                                  ("eof-confirm", True, "\x04")):
        run = TerminalRun(name)
        run.begin()
        if confirm:
            run.hidden("App password (input hidden): ", PASSWORD + "\n")
            prompt = "Confirm app password (input hidden): "
        else:
            prompt = "App password (input hidden): "
        run.hidden(prompt, cancel)
        run.finish(130 if cancel == "\x03" else 1)
        assert not any(json.loads(line)["method"] in ("POST", "PUT")
                       for line in (run.state / "api_calls.jsonl").read_text().splitlines())

    run = TerminalRun("term-during-input")
    run.begin()
    run.hidden("App password (input hidden): ", "")
    run.proc.send_signal(signal.SIGTERM)
    run.finish(143)

    run = TerminalRun("new-provision-failure", extra={"MOCK_API_LOSE_RESPONSE": "paratrooper-web"})
    run.begin()
    run.hidden("App password (input hidden): ", PASSWORD + "\n")
    run.hidden("Confirm app password (input hidden): ", PASSWORD + "\n")
    assert_layout(run.finish(1))
    state = json.loads((run.state / "api_state.json").read_text())
    assert state["services"]["paratrooper-web"]["_envVars"]["PARATROOPER_APP_TOKEN"] == PASSWORD

    exercise_token()


def to_claude_step(run):
    run.expect("Ready to begin? (y / n) ")
    run.send("y")
    run.expect("Use this workspace for Paratrooper? (y / s / n) ")
    run.send("y")


def finish_new_install(run):
    run.expect("answer: ")
    run.send("n")
    run.hidden("App password (input hidden): ", PASSWORD + "\n")
    run.hidden("Confirm app password (input hidden): ", PASSWORD + "\n")
    return run.finish(0)


def worker_token(run):
    state = json.loads((run.state / "api_state.json").read_text())
    return state["services"]["paratrooper-worker"]["_envVars"]["CLAUDE_CODE_OAUTH_TOKEN"]


def no_render_api_calls(run):
    assert not (run.state / "api_calls.jsonl").exists(), "called the Render API"


def exercise_token():
    """setup-token's real screen, the hidden paste fallback and the token test."""
    # The realistic screen: the token is found by its shape and tested first.
    found = TerminalRun("token-found", extra={"MOCK_CLAUDE_WRAP": "1"})
    to_claude_step(found)
    found.expect("Claude Code token captured.")
    found.expect("Claude accepted the token.")
    output = finish_new_install(found)
    assert "Claude Code token (input hidden)" not in output
    assert worker_token(found) == FIXTURE_TOKEN

    # No token in the output: explain, then a hidden paste with a shape check,
    # an empty entry and edge spaces, then the pasted token is tested and used.
    paste = TerminalRun("token-missing-paste",
                        extra={"MOCK_CLAUDE_TOKEN": "", "MOCK_CLAUDE_ACCEPT_TOKEN": PASTED_TOKEN})
    to_claude_step(paste)
    paste.expect("Claude Code finished, but its token could not be read from its output.")
    paste.hidden("Claude Code token (input hidden): ", "not-a-claude-token\n")
    paste.expect("That does not look like a Claude Code token. It starts with sk-ant-.")
    paste.hidden("Claude Code token (input hidden): ", "\n")
    paste.expect("That was empty. Paste the token, or press Ctrl-C to cancel.")
    paste.hidden("Claude Code token (input hidden): ", "  " + PASTED_TOKEN + " \n")
    paste.expect("Claude Code token received.")
    paste.expect("Claude accepted the token.")
    output = finish_new_install(paste)
    assert "not-a-claude-token" not in output
    assert worker_token(paste) == PASTED_TOKEN
    assert "oauth=expected extra=[] config=fresh-empty" in (paste.state / "claude_check.calls").read_text()

    # Two different tokens on the screen: the same paste prompt; EOF stops cleanly.
    ambiguous = TerminalRun("token-ambiguous-eof", extra={"MOCK_CLAUDE_EXTRA_TOKEN": OTHER_TOKEN})
    to_claude_step(ambiguous)
    ambiguous.expect("Claude Code printed more than one token, so it is unclear which to use.")
    ambiguous.hidden("Claude Code token (input hidden): ", "\x04")
    output = ambiguous.finish(1)
    assert "No token, so nothing was set up." in output
    assert not (ambiguous.state / "claude_check.calls").exists()
    no_render_api_calls(ambiguous)

    paste_cancel = TerminalRun("token-paste-ctrl-c", extra={"MOCK_CLAUDE_TOKEN": ""})
    to_claude_step(paste_cancel)
    paste_cancel.hidden("Claude Code token (input hidden): ", "\x03")
    paste_cancel.finish(130)
    no_render_api_calls(paste_cancel)

    # Claude refuses the captured token: stopping creates nothing on Render.
    refused = TerminalRun("token-refused-stop", extra={"MOCK_CLAUDE_ACCEPT_TOKEN": OTHER_TOKEN})
    to_claude_step(refused)
    refused.expect("Claude did not accept this token. Nothing was set up on Render.")
    refused.expect("Paste a new token? (p / n) ")
    refused.send("n")
    output = refused.finish(1)
    assert "Claude accepted the token." not in output
    no_render_api_calls(refused)

    # Or paste a new one, which is tested again before anything continues.
    repaste = TerminalRun("token-refused-paste", extra={"MOCK_CLAUDE_ACCEPT_TOKEN": PASTED_TOKEN})
    to_claude_step(repaste)
    repaste.expect("Paste a new token? (p / n) ")
    repaste.send("p")
    repaste.hidden("Claude Code token (input hidden): ", PASTED_TOKEN + "\n")
    repaste.expect("Claude accepted the token.")
    finish_new_install(repaste)
    assert worker_token(repaste) == PASTED_TOKEN
    checks = (repaste.state / "claude_check.calls").read_text().splitlines()
    assert [line.split()[0] for line in checks] == ["oauth=other", "oauth=expected"], checks

    # A test that could not run offers to run it again.
    offline = TerminalRun("token-check-offline-stop", extra={"MOCK_CLAUDE_CHECK_OFFLINE": "1"})
    to_claude_step(offline)
    offline.expect("Could not test the token with Claude. Nothing was set up on Render.")
    offline.expect("Test again or paste a token? (r / p / n) ")
    offline.send("r")
    offline.expect("Test again or paste a token? (r / p / n) ")
    offline.send("n")
    text = screen(offline.finish(1))
    step = text[text.index("✓ claude found."):]
    assert "\n\n\n" not in step, ("two blank lines in a row", step)
    assert len((offline.state / "claude_check.calls").read_text().splitlines()) == 2
    no_render_api_calls(offline)

    # Ctrl-C while the test waits on Claude stops the tracked child cleanly.
    check_cancel = TerminalRun("token-check-ctrl-c", extra={"MOCK_CLAUDE_CHECK_WAIT": "1"})
    to_claude_step(check_cancel)
    check_cancel.expect("Testing the token with Claude ...")
    deadline = time.monotonic() + 10
    while not (check_cancel.state / "claude_check.ppid").exists():
        assert time.monotonic() < deadline, "the token test did not reach the mock wait"
        check_cancel.read()
    check_cancel.send("\x03")
    check_cancel.finish(130)
    assert_stopped(check_cancel.state / "claude_check.pid")
    no_render_api_calls(check_cancel)


if __name__ == "__main__":
    try:
        exercise()
    finally:
        print("Terminal evidence: " + str(RUN))
