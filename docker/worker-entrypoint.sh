#!/bin/sh
# Start-up wrapper for the worker: hand the worker-only secrets over without
# leaving them in its launch record.
#
# /proc/<pid>/environ is the environment a process was STARTED with. Popping a
# value out of os.environ afterwards does not change that file, and the file is
# readable by the process's own user, which is the agent's user too. So the only
# way a value is not in the worker's launch record is for the worker not to be
# started with it.
#
# This script is therefore the process the platform starts with the secrets. It
# writes them to a private file, removes them from its own environment, and
# execs the worker, which reads the file once and deletes it. The Claude
# credential is not on this list on purpose: the CLI needs it in its own
# environment, so it is in this record, and what covers it is the CLI keeping it
# out of the shells it opens plus the guard's refusal of a /proc read on both
# roads, the shell's and the file tools'. Those are fences on what is asked for,
# not a sandbox around it — the switch that sandboxed the agent's shells is off,
# because this platform refuses the mount that sandbox makes first.
set -eu

# owner-only from the moment it exists, not a chmod after the fact
umask 077

SECRETS_FILE="${PARATROOPER_SECRETS_FILE:-/dev/shm/paratrooper-secrets}"

: > "$SECRETS_FILE"
chmod 0600 "$SECRETS_FILE"

# One NAME=value per line, values single-line by construction (an address, two
# ids, two keys).
for name in \
    SPOTIFY_CLIENT_ID \
    SPOTIFY_CLIENT_SECRET \
    REDIS_URL \
    PARATROOPER_GITHUB_APP_ID \
    PARATROOPER_GITHUB_APP_INSTALLATION_ID
do
    eval "value=\${$name:-}"
    if [ -n "$value" ]; then
        printf '%s=%s\n' "$name" "$value" >> "$SECRETS_FILE"
    fi
    unset "$name"
done
unset value

# The App's private key travels the same road as the two ids above, and for the
# same reason, but it is a PEM: several lines, where the format above is one
# NAME=value per line. So it goes across base64-encoded, under its own name, and
# the worker decodes it. Encoding rather than changing the format is deliberate:
# every other value, and every reader and test of this file, stays exactly as it
# was, and one line can hold a key of any shape, including a key pasted with the
# line breaks written out as backslash-n, which the worker straightens back into
# a PEM. The value reaches base64 on stdin, so it is in no command line;
# base64 wraps its output at 76 columns, which `tr` takes back out.
if [ -n "${PARATROOPER_GITHUB_APP_KEY_PEM:-}" ]; then
    encoded="$(printf '%s' "$PARATROOPER_GITHUB_APP_KEY_PEM" | base64 | tr -d '\n')"
    printf '%s=%s\n' PARATROOPER_GITHUB_APP_KEY_PEM_B64 "$encoded" >> "$SECRETS_FILE"
    unset encoded
fi
unset PARATROOPER_GITHUB_APP_KEY_PEM

# the path is not a secret, and the worker reads it to know the wrapper ran;
# without it the worker reads the environment directly, which is local dev
export PARATROOPER_SECRETS_FILE="$SECRETS_FILE"

exec python -m paratrooper.web.worker_runner
