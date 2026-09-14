OFFLINE INSTALLER REGRESSIONS

These fixtures run real Paratrooper provisioning code and real httpx,
PyYAML and cryptography libraries. Render HTTP calls use MockTransport;
Render, Claude and curl commands use the bin/ fakes. No account is needed.
The fixture state contains distinctive fake credentials for assertions.

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
installer in the checkout.

run_install_tests.sh covers bootstrap, setup errors, both idle choices,
passphrase entry, validation errors, readiness, reruns and partial installs.
Run it ONLY in a disposable copy of the candidate source and these fixtures.
It deliberately exercises the installer's config-writing step, so the source
copy's config/paratrooper.toml will be written. It requires an offline dependency
directory and uses empty temporary homes and mocked provider commands. For a
strictly isolated run, start with env -i, a PATH containing a socket-blocking
Python wrapper and /usr/bin:/bin, and disable user site imports and bytecode.
The delivery REPORT.txt records the exact runner and paths used for this change.

Password behavior: new installs ask for 20 or more printable ASCII characters,
with internal spaces and punctuation allowed, and matching confirmation.
Existing installs explicitly keep their existing password without re-entry,
retrieval to the terminal, or rotation. A missing existing password or a changed
web service stops the run. A partial install with no web service asks for a
password before creating that service. A lost response after web creation is
resumed by confirming that the current password is kept.
