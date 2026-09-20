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
bin/claude mock the Render CLI and Claude Code. The download/install boundary is
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
Code with y (installed, then found) and n (stops before sign in, exit 0); both
idle choices; passphrase entry; a failed blueprint gate stopping the unnumbered
prepare section; readiness; reruns; partial installs; cancellation; EOF; and
secret hiding. Run it ONLY in a disposable copy of the candidate source and these
fixtures. It deliberately exercises the installer's config-writing step, so the
source copy's config/paratrooper.toml will be written. It requires an offline
dependency directory and uses empty temporary homes and mocked provider commands.
For a strictly isolated run, start with env -i, a PATH containing a
socket-blocking Python wrapper and /usr/bin:/bin, and disable user site imports
and bytecode. The delivery REPORT.txt records the exact runner and paths used for
this change.

Password behavior: new installs ask for 20 or more printable ASCII characters,
with internal spaces and punctuation allowed, and matching confirmation.
Existing installs explicitly keep their existing password without re-entry,
retrieval to the terminal, or rotation. A missing existing password or a changed
web service stops the run. A partial install with no web service asks for a
password before creating that service. A lost response after web creation is
resumed by confirming that the current password is kept.
