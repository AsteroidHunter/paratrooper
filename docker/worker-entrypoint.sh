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
# credential is not on this list on purpose: the CLI needs it in its
# environment, and the scrub switch plus the file deny rules cover it instead.
set -eu

# owner-only from the moment it exists, not a chmod after the fact
umask 077

SECRETS_FILE="${PARATROOPER_SECRETS_FILE:-/dev/shm/paratrooper-secrets}"

: > "$SECRETS_FILE"
chmod 0600 "$SECRETS_FILE"

# One NAME=value per line, values single-line by construction (an address, two
# ids, two keys). The App's private key is not here: it arrives as its own
# mounted file and is read straight from there.
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

# the path is not a secret, and the worker reads it to know the wrapper ran;
# without it the worker reads the environment directly, which is local dev
export PARATROOPER_SECRETS_FILE="$SECRETS_FILE"

exec python -m paratrooper.web.worker_runner
