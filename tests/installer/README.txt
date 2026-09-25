OFFLINE INSTALLER REGRESSIONS

These fixtures run real Paratrooper provisioning code and real httpx,
PyYAML and cryptography libraries. Render HTTP calls use MockTransport;
uv, Render, Claude and curl commands use the bin/ fakes. No account is needed.
The fixture state contains distinctive fake credentials for assertions.

The installer flow these fixtures cover, in order: step 0 Python (an isolated
environment built with uv), step 1 Render (the Render CLI, then sign in), step 2
Claude Code (Claude Code, then sign in), step 3 idle sleeping, step 4 app
password, then the unnumbered "Preparing your deployment" and "Provisioning on
Render" sections. Steps 0 through 2 ask a y/n before obtaining a missing tool:
uv, the Render CLI or Claude Code.

The bin/ fakes stand in for the provider tools. bin/uv creates the virtual
environment with the python3 on PATH, the same way the tests used to build one,
so no real uv and no network are touched; the installer's air-gapped path then
makes the vendored dependencies importable with a .pth file. bin/render and
bin/claude mock the Render CLI and Claude Code.

bin/claude setup-token prints what the real CLI (2.1.278 to 2.1.280) writes to
a pipe, in the same order: input-mode switches, the welcome and sign-in screen,
the success screen with the token on its own line (in color, one column in,
optionally wrapped at 80 columns), the lines after it including the literal
"export CLAUDE_CODE_OAUTH_TOKEN=<token>" hint, and terminal reset codes as the
very last output. The token is not the last line, so a capture that keeps the
last line fails these fixtures. bin/claude -p is the installer's token test: it
answers OK only for the expected token (MOCK_CLAUDE_ACCEPT_TOKEN, else
MOCK_CLAUDE_TOKEN) and fails like the real CLI's 401 otherwise, and it records
what it saw about its own environment (never the token) in claude_check.calls.
Other switches: MOCK_CLAUDE_WRAP, MOCK_CLAUDE_EXTRA_TOKEN (a second, different
token), MOCK_CLAUDE_CHECK_OFFLINE and MOCK_CLAUDE_CHECK_WAIT. The download/install boundary is
mocked with installer hooks (PARATROOPER_INSTALL_UV_INSTALLER,
PARATROOPER_INSTALL_RENDER_INSTALLER, PARATROOPER_INSTALL_CLAUDE_INSTALLER): the
uv and render hooks drop the fake binary where the installer expects it, and the
claude hook mimics the native installer by placing claude under ~/.local/bin.

Requirements: Bash, Python 3.12+, and an existing offline library directory
containing the project's deploy dependencies plus py_vapid for the existing
notification-key compatibility check. No new runtime dependency was added.
Set PARATROOPER_INSTALL_TEST_DEPS to that directory.

Run test_provision.py directly for provisioner and readiness checks:
  python3 tests/installer/test_provision.py

Run check_terminal.py for actual terminal echo, cancellation, secret transport,
trace flags, inherited exports, successful creation and failure-path checks:
  python3 tests/installer/check_terminal.py
This creates its own isolated source copy, fake home, Python wrapper and socket
blocker. Its output names the temporary evidence directory. It never runs the
installer in the checkout. Its pre-built environment is reused by step 0, so uv
is not exercised there; the render and claude fakes are on PATH, so steps 1 and 2
announce them and ask nothing.

Both runners check the screen layout below "Configuration is valid.": never two
blank lines in a row, no indented line, and a blank line before each warning,
result, error or question.

run_install_tests.sh covers bootstrap; step 0 building with uv present and with
uv obtained through the hook after consent, missing uv declined or canceled at
EOF without running the hook, plus a uv obtain failure that stops before any
cloud creation. Separate processes with the same fake home verify cached uv is
found when another environment is built, and cached Render is found without a
second install prompt. Step 1 offers to install a missing Render CLI with y (obtained
through the hook and through a mocked official release ZIP for macOS and Linux
architectures, including release and archive failures) and n (stops before sign
in, exit 0). It also covers a fresh Render login with no workspace and explicit
confirmation on every run: selecting the second workspace continues there,
a saved selection is shown for confirmation, and switching works even when
RENDER_WORKSPACE overrides the saved setting. Decline, EOF, picker cancellation,
an empty account or an unrelated workspace check error stops before any app
resource inspection. Step 2
offers to install a missing Claude
Code with y (installed, then found) and n (stops before sign in, exit 0). The
Claude token is read from the realistic screen, wrapped or not, with a future
version label, and saved exactly; the token test sees only that token, with the
caller's own Claude and Anthropic variables removed and a fresh empty config
folder; no token or two different tokens stop a piped run; a refused token, an
offline test and a test that runs out of time all stop before any Render API
call. check_terminal.py adds the terminal paths: the hidden paste with its shape
check, EOF and Ctrl-C at the paste, stop or paste again after a refused token,
test again after an offline test, and Ctrl-C during the test. It also covers
both idle choices; passphrase entry; a failed blueprint gate stopping the unnumbered
prepare section; readiness; reruns; partial installs; cancellation; EOF; and
secret hiding. Run it ONLY in a disposable copy of the candidate source and these
fixtures. It deliberately exercises the installer's config-writing step, so the
source copy's config/paratrooper.toml will be written. It requires an offline
dependency directory and uses empty temporary homes and mocked provider commands.
For a strictly isolated run, start with env -i, a PATH containing a
socket-blocking Python wrapper and /usr/bin:/bin, and disable user site imports
and bytecode. The delivery REPORT.txt records the exact runner and paths used for
this change.

Password behavior: new installs ask for at least 11 printable ASCII characters,
including a letter, a number and a symbol, with matching confirmation. Internal
spaces are allowed but do not count as the symbol; edge spaces are rejected.
Existing installs explicitly keep their existing password without re-entry,
retrieval to the terminal, or rotation. A missing existing password or a changed
web service stops the run. A partial install with no web service asks for a
password before creating that service. A lost response after web creation is
resumed by confirming that the current password is kept.
