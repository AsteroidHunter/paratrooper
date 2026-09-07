# Pinning

Every version this app builds on is written down somewhere in the repo. Nothing
is chosen by the calendar. This note says where each pin lives and how to move
one on purpose.

## What is pinned, and where

| Layer | Pinned by | Notes |
| --- | --- | --- |
| Python packages, web image | `constraints-web.txt` | verbatim `pip freeze` of the live web service |
| Python packages, worker image | `constraints-agent.txt` | verbatim `pip freeze` of the live worker |
| Claude Agent SDK | `pyproject.toml` (`==`) | pinned there because the reason is written there: the SDK bundles the CLI whose env scrub the worker depends on |
| Phone-app packages | `pwa/package-lock.json` | `Dockerfile.web` installs with `npm ci`, which refuses to drift from the lock |
| Base images | `FROM ...@sha256:` in both Dockerfiles | tag and date named in the comment above each |
| Chromium | follows `playwright` in `constraints-agent.txt` | the browser revision is chosen by the pinned package, not fetched loose |

`pyproject.toml` keeps ranges, not pins. The ranges are the intent, the floor
each package has to clear for the code to work. The constraints files are the
fact, the version each image actually holds today. Keeping them apart means a
range never has to be edited to record a routine version move, and a transitive
package can be pinned without being promoted to a direct dependency it is not.

## Bumping the Python packages

The constraints files are readings, not opinions, so the way to change one is to
change what is running and read it again.

1. Loosen deliberately. Edit only the line you mean to move, or delete the file
   and let the ranges re-resolve if the point is a wholesale refresh.
2. Rebuild and deploy the image, then read the result back from the container
   itself:

   ```
   ssh srv-...@ssh.oregon.render.com 'python -m pip freeze'
   ```

   Drop the `-e /app` line and the editable-install comment; those two cannot
   appear in a constraints file. Keep the rest exactly as printed.
3. Check the set is closed, meaning the ranges plus the constraints resolve to
   the constraints and nothing else. From the repo root, with `uv` on the path:

   ```
   uv pip compile --python-version 3.12 --python-platform x86_64-unknown-linux-gnu \
       -c constraints-web.txt <(printf '%s\n' 'numpy>=2.0' 'scipy>=1.13' 'pillow>=10.3' \
       'fastapi>=0.110' 'httpx>=0.27' 'uvicorn[standard]>=0.29' 'python-multipart>=0.0.9' \
       'websockets>=12.0' 'redis>=5.0' 'pywebpush>=2.0')
   ```

   The output should list the same packages at the same versions as the
   constraints file. A package in the output that is missing from the file is a
   package that still floats.
4. Run the suites: `.venv/bin/python -m pytest -q tests/` and, in `pwa/`,
   `npm test`, `npx tsc --noEmit`, `npm run build`.

The web and worker sets are kept in separate files on purpose. Neither image
should be able to gain the other's packages by way of a shared list.

## Bumping a base image

The digest is what the tag pointed at on the date in the comment. To move it,
fetch the tag's current manifest-list digest, which is the one that works across
platforms:

```
REPO=library/python           # or library/node
TAG=3.12-slim                 # or 22-slim
TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$REPO:pull" \
        | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -sI -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/vnd.oci.image.index.v1+json" \
     -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
     "https://registry-1.docker.io/v2/$REPO/manifests/$TAG" | grep -i docker-content-digest
```

Write the new digest into both `FROM` lines that use it and update the date in
the comment beside each. Both Dockerfiles use the same Python base, so the two
move together.

## What still floats

Pinning has an edge, and this is where it currently sits.

- **The nodesource setup script.** `Dockerfile.worker` pipes
  `https://deb.nodesource.com/setup_22.x` into a shell. The major is pinned at
  22, which is what the worker runs, but the patch level is whatever their apt
  suite holds on the day of the build. Closing it means dropping the script and
  installing a named `nodejs=22.23.2-1nodesource1` against a keyring and apt
  source written into the image directly. That is a different install route, so
  it is a follow-up rather than a side effect of a pinning pass.
- **Debian packages.** `apt-get install` of `git`, `ca-certificates`, `curl`,
  `bubblewrap` and Playwright's `--with-deps` browser libraries take whatever
  the pinned base image's suite offers. The base image digest holds most of this
  still, since the package lists it ships with are fixed; the security suite is
  the part that can move. Full closure means naming a version per package or
  using a snapshot mirror, both of which age badly.
- **The build backend.** `pip install -e .` builds the package in an isolated
  environment that fetches `hatchling` and its dependencies fresh. A `-c` on the
  command line does not reach into that environment; only the `PIP_CONSTRAINT`
  environment variable does. It is build-time only and none of it ships in the
  image, so it is noted rather than fixed.
- **pip itself.** Both images use the pip that ships in the base image, 25.0.1
  today, so it moves only when the base image digest moves.

## The test that guards this

`tests/test_agent.py` holds the check. It fails if a dependency in
`pyproject.toml` has no exact version in the matching constraints file, if a
`FROM` line in either Dockerfile carries a bare tag instead of a digest, if a
Dockerfile installs without its `-c`, or if the phone-app build stops using
`npm ci`. It is there so that adding a package and forgetting to pin it is a
red suite rather than a surprise on a rebuild months later.
