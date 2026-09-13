"""Tests for the config delivery command (``python -m paratrooper.deploy``).

Nothing here touches a network, a real Render workspace, the user's own Render
CLI credentials or the private ``config/paratrooper.toml``. Every API call goes
through an ``httpx.MockTransport`` that records the exact request sequence, which
is what makes idempotence something demonstrated rather than claimed: "a second
run writes nothing" is only true if you can see that no PUT was sent.

Two deliberate choices in the fixture below. The credential file is always one
this test wrote in ``tmp_path`` — the real ``~/.render/cli.yaml`` is never read,
including by the tests for what a malformed one does. And the mock's host is a
fake one, so a transport that somehow escaped the mock would still not be
pointed at Render.
"""

from __future__ import annotations

import base64
import json
import traceback
from pathlib import Path

import httpx
import pytest

from confighelpers import example_table, example_text
from paratrooper.agent.config import CONFIG_VAR, ConfigError
from paratrooper.deploy import (
    CONFIG_KEY,
    DEFAULT_API_HOST,
    MAX_PAGES,
    SERVICE_NAMES,
    WEB_SERVICE,
    WORKER_SERVICE,
    Credential,
    DeployError,
    RenderClient,
    cli_config_path,
    encode_source,
    main,
    official_api_host,
    push,
    read_source,
    resolve_credential,
    resolve_workspace,
)

WORKSPACE = "tea-0000000000000000000"
WEB_ID, WORKER_ID = "srv-web00000000000000", "srv-wrk00000000000000"
# A body this command is never allowed to repeat back to anyone.
API_BODY_SENTINEL = "render-said-this-and-it-stays-there"


def _source(tmp_path, text=None):
    path = tmp_path / "paratrooper.toml"
    path.write_text(text if text is not None else example_text(), encoding="utf-8")
    return path


def _cli_config(tmp_path, text):
    """A Render CLI config file belonging to this test and nobody else."""
    path = tmp_path / "cli.yaml"
    path.write_text(text, encoding="utf-8")
    return path


class _Render:
    """A Render workspace that answers the handful of calls this command makes,
    and records every request it received — including the ones it should never
    receive, so that "never read the bulk environment" is checkable."""

    def __init__(
        self,
        *,
        values: dict[str, str | None] | None = None,
        suspended: frozenset[str] = frozenset(),
        duplicates: frozenset[str] = frozenset(),
        missing: frozenset[str] = frozenset(),
        foreign: frozenset[str] = frozenset(),
        deploys: dict[str, list[str]] | None = None,
        deploy_during_write: frozenset[str] = frozenset(),
        nameless_deploy: frozenset[str] = frozenset(),
        fail: dict[tuple[str, str], int] | None = None,
        no_answer: frozenset[tuple[str, str]] = frozenset(),
        garbled: frozenset[tuple[str, str]] = frozenset(),
        pages: int = 1,
        endless: str = "",
    ) -> None:
        self.ids = {WEB_SERVICE: WEB_ID, WORKER_SERVICE: WORKER_ID}
        # Each service's whole environment. Everything other than this command's
        # own key is a secret it must neither read nor disturb.
        self.env: dict[str, dict[str, str]] = {
            WEB_ID: {"VAPID_PRIVATE_KEY": "vapid-secret", "REDIS_URL": "redis://web"},
            WORKER_ID: {"CLAUDE_CODE_OAUTH_TOKEN": "claude-secret", "REDIS_URL": "redis://wrk"},
        }
        for service_id, value in (values or {}).items():
            if value is not None:
                self.env[service_id][CONFIG_KEY] = value
        self.suspended = suspended
        self.duplicates = duplicates
        self.missing = missing
        self.foreign = foreign
        # latest-first deploy lists, per service id
        self.deploys = deploys or {WEB_ID: ["dep-old-web"], WORKER_ID: ["dep-old-wrk"]}
        self.deploy_during_write = deploy_during_write
        self.nameless_deploy = nameless_deploy
        self.fail = fail or {}
        self.no_answer = no_answer
        self.garbled = garbled
        self.pages = pages
        self.endless = endless
        self.requests: list[tuple[str, str]] = []
        self.bulk_reads: list[str] = []
        self.deployed: list[str] = []
        self._cursors = 0

    def _name_of(self, service_id):
        return next(n for n, i in self.ids.items() if i == service_id)

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.requests.append((request.method, path))
        assert request.headers["authorization"] == "Bearer test-key"

        for method, fragment in self.no_answer:
            if request.method == method and fragment in path:
                raise httpx.ConnectTimeout("the network, as it sometimes is", request=request)
        for (method, fragment), status in self.fail.items():
            if request.method == method and fragment in path:
                return httpx.Response(status, json={"message": API_BODY_SENTINEL})
        for method, fragment in self.garbled:
            if request.method == method and fragment in path:
                return httpx.Response(
                    200,
                    content=f"<html>{API_BODY_SENTINEL}</html>".encode(),
                    headers={"content-type": "application/json"},
                )

        if path.endswith("/services"):
            return self._services(request)
        if "/env-vars/" in path:
            return self._one_var(request, path)
        if path.endswith("/env-vars"):
            return self._all_vars(request, path)
        if path.endswith("/deploys"):
            return self._deploys(request, path)
        return httpx.Response(404, json={"message": "unhandled"})

    def _one_var(self, request, path):
        """``/services/{id}/env-vars/{key}``: the single-variable endpoint, which
        answers with that one variable or 404."""
        service_id, key = path.split("/services/")[1].split("/env-vars/")
        if request.method == "PUT":
            self.env[service_id][key] = json.loads(request.content)["value"]
            if self._name_of(service_id) in self.deploy_during_write:
                # somebody else's deploy, landing in exactly this interval
                self.deploys[service_id].insert(0, f"dep-concurrent-{service_id[-3:]}")
            return httpx.Response(200, json={"key": key, "value": self.env[service_id][key]})
        value = self.env[service_id].get(key)
        if value is None:
            return httpx.Response(
                404, json={"id": "abc", "message": "Not Found", "code": "not_found"}
            )
        return httpx.Response(200, json={"key": key, "value": value})

    def _all_vars(self, request, path):
        """The bulk listing. It works, and this command still never calls it:
        its first page is other people's secrets, and on a service with enough
        variables this command's own key is not even on it."""
        service_id = path.split("/services/")[1].split("/")[0]
        self.bulk_reads.append(service_id)
        if request.method != "GET":
            return httpx.Response(200, json=[])
        if request.url.params.get("cursor") is None:
            return httpx.Response(200, json=[
                {"envVar": {"key": f"OTHER_{i:03d}", "value": "a secret"}, "cursor": f"p1-{i}"}
                for i in range(100)
            ])
        return httpx.Response(200, json=[
            {"envVar": {"key": k, "value": v}, "cursor": k}
            for k, v in self.env[service_id].items()
        ])

    def _deploys(self, request, path):
        service_id = path.split("/services/")[1].split("/")[0]
        if request.method == "POST":
            self.deployed.append(service_id)
            if self._name_of(service_id) in self.nameless_deploy:
                return httpx.Response(201, json={"status": "queued"})
            new = f"dep-requested-{service_id[-3:]}"
            self.deploys[service_id].insert(0, new)
            return httpx.Response(201, json={"id": new, "trigger": "api", "status": "queued"})
        latest = self.deploys[service_id][:1]
        return httpx.Response(200, json=[{"deploy": {"id": d}, "cursor": d} for d in latest])

    def _entry(self, name, *, service_id=None, owner=WORKSPACE, cursor="c-final"):
        return {
            "service": {
                "id": service_id or self.ids[name],
                "name": name,
                "ownerId": owner,
                "suspended": "suspended" if name in self.suspended else "not_suspended",
            },
            "cursor": cursor,
        }

    def _services(self, request):
        params = request.url.params
        assert params["ownerId"] == WORKSPACE, "a workspace is always named"
        name = params["name"]
        if self.endless:
            # a listing that always has one more page: either advancing forever
            # or handing back the same cursor
            self._cursors += 1
            mark = "stuck" if self.endless == "stuck" else f"page-{self._cursors}"
            return httpx.Response(200, json=[
                self._entry("something-else", service_id=f"srv-filler{i:04d}", cursor=mark)
                for i in range(100)
            ])
        if name in self.missing:
            return httpx.Response(200, json=[])
        cursor = params.get("cursor")
        if cursor in ("c-final", "c-foreign"):
            return httpx.Response(200, json=[])
        # a filler page of other services, to prove every page is read
        if self.pages > 1 and cursor is None:
            return httpx.Response(200, json=[
                self._entry("something-else", service_id=f"srv-filler{i:04d}",
                            cursor=f"page1-{i}")
                for i in range(100)
            ])
        rows = [self._entry(name)]
        if name in self.duplicates:
            rows.append(self._entry(name))
        if name in self.foreign:
            rows.append(self._entry(name, service_id="srv-elsewhere000000000",
                                    owner="tea-somebody-elses-0000", cursor="c-foreign"))
        return httpx.Response(200, json=rows)

    def client(self):
        credential = Credential(token="test-key", source="a test", host="https://api.test/v1")
        return RenderClient(
            credential, http=httpx.Client(transport=httpx.MockTransport(self.handler))
        )


def _push(tmp_path, render, **kwargs):
    report = push(_source(tmp_path), client=render.client(), workspace=WORKSPACE, **kwargs)
    # every push test carries this: the bulk environment listing is never read,
    # whatever else the run did
    assert render.bulk_reads == []
    return report


# --- check: pure, local, no credential ---------------------------------------


def test_check_validates_with_the_services_own_loader(tmp_path, capsys, monkeypatch):
    """The same validator the service boots with, so "check passed" means "it
    would boot" rather than "it parsed as TOML"."""
    for name in ("RENDER_API_KEY", "RENDER_WORKSPACE", CONFIG_VAR,
                 "PARATROOPER_INBOX", "PARATROOPER_SITE_ROOT"):
        monkeypatch.delenv(name, raising=False)
    assert main(["check", str(_source(tmp_path))]) == 0
    out = capsys.readouterr().out
    assert "valid, profile pinboard" in out
    assert "encoded length" in out
    # and it says a length rather than the value
    assert encode_source(example_text()) not in out


def test_check_refuses_a_source_that_could_not_boot(tmp_path, capsys):
    broken = example_table()
    broken["uploads"]["ttl_hours"] = 0
    text = example_text().replace("uploads.ttl_hours = 24", "uploads.ttl_hours = 0")
    assert main(["check", str(_source(tmp_path, text))]) == 2
    assert "ttl_hours" in capsys.readouterr().err


def test_read_source_reports_a_missing_or_unparsable_file(tmp_path):
    with pytest.raises(DeployError, match="cannot read"):
        read_source(tmp_path / "nope.toml")
    with pytest.raises(DeployError, match="not valid TOML"):
        read_source(_source(tmp_path, "schema = = 1"))


def test_the_encoding_is_the_one_the_loader_decodes():
    from paratrooper.agent.config import decode_config_value

    value = encode_source(example_text())
    assert "\n" not in value
    assert base64.b64decode(value).decode() == example_text()
    assert decode_config_value(value).profile == "pinboard"


# --- credentials and workspace ------------------------------------------------


def test_an_api_key_wins_over_a_saved_cli_token(tmp_path, monkeypatch):
    cli = _cli_config(tmp_path, "api:\n  key: saved-token\n  expires_at: 99999999999\n")
    monkeypatch.setenv("RENDER_CLI_CONFIG_PATH", str(cli))
    monkeypatch.setenv("RENDER_API_KEY", "from-env")
    credential = resolve_credential()
    assert credential.token == "from-env"
    assert credential.source == "$RENDER_API_KEY"
    assert credential.host == DEFAULT_API_HOST


def test_a_saved_cli_token_is_used_only_while_it_is_unexpired(tmp_path, monkeypatch):
    cli = _cli_config(
        tmp_path, "workspace: tea-abc\napi:\n  key: saved-token\n  expires_at: 2000\n"
    )
    monkeypatch.setenv("RENDER_CLI_CONFIG_PATH", str(cli))
    monkeypatch.delenv("RENDER_API_KEY", raising=False)
    assert resolve_credential(now=1000).token == "saved-token"
    with pytest.raises(DeployError, match="expired"):
        resolve_credential(now=3000)
    # and the moment it names is the moment it stops
    with pytest.raises(DeployError, match="expired"):
        resolve_credential(now=2000)


@pytest.mark.parametrize(
    ("expiry", "what"),
    [
        ("", "absent"),
        ("  expires_at: 0\n", "zero"),
        ("  expires_at: -5\n", "in the past as a sign, not a time"),
        ('  expires_at: "99999999999"\n', "a string"),
        ("  expires_at: true\n", "a boolean"),
        ("  expires_at: .nan\n", "not a number"),
        (f"  expires_at: {10**400}\n", "too large to represent"),
        ("  expires_at: soon\n", "a word"),
    ],
)
def test_a_saved_token_without_a_readable_expiry_is_not_a_credential(
    tmp_path, monkeypatch, expiry, what
):
    """The documented fallback is an *unexpired* saved CLI token. The CLI writes
    ``api.expires_at`` as Unix seconds; anything this command cannot read as one
    leaves it unable to say the token is live, and "cannot say" is not "yes".
    ``what`` only names the case in the test output."""
    cli = _cli_config(tmp_path, f"api:\n  key: saved-token\n{expiry}")
    monkeypatch.setenv("RENDER_CLI_CONFIG_PATH", str(cli))
    monkeypatch.delenv("RENDER_API_KEY", raising=False)
    with pytest.raises(DeployError) as err:
        resolve_credential(now=1000)
    message = str(err.value)
    assert "expiry" in message, what
    # and it says both ways out, rather than leaving a 401 to explain itself
    assert "RENDER_API_KEY" in message and "render login" in message
    assert "saved-token" not in message


def test_no_credential_at_all_says_what_to_do(tmp_path, monkeypatch):
    monkeypatch.setenv("RENDER_CLI_CONFIG_PATH", str(tmp_path / "absent.yaml"))
    monkeypatch.delenv("RENDER_API_KEY", raising=False)
    with pytest.raises(DeployError) as err:
        resolve_credential()
    assert "RENDER_API_KEY" in str(err.value) and "render login" in str(err.value)


def test_a_malformed_cli_config_never_quotes_the_file(tmp_path, monkeypatch, capsys):
    """A YAML parse error quotes the line it choked on. On a half-written
    credential file that line is the credential, so the error names the file and
    the kind of failure and stops there — in its message, in its repr, and in a
    traceback, which is why the cause is suppressed rather than chained."""
    sentinel = "rnd_SENTINEL_NEVER_PRINT_ME"
    cli = _cli_config(tmp_path, f'version: 1\napi:\n  key: "{sentinel}\n  expires_at: 99\n')
    monkeypatch.setenv("RENDER_CLI_CONFIG_PATH", str(cli))
    monkeypatch.delenv("RENDER_API_KEY", raising=False)

    with pytest.raises(DeployError) as err:
        resolve_credential()
    rendered = "".join(traceback.format_exception(err.value)) + repr(err.value)
    assert sentinel not in rendered
    assert str(cli) in str(err.value) and "YAML" in str(err.value)
    assert "RENDER_API_KEY" in str(err.value) and "render login" in str(err.value)

    # the same file through the command line, which is where a person would see it
    monkeypatch.setenv("RENDER_WORKSPACE", WORKSPACE)
    assert main(["push", str(_source(tmp_path))]) == 2
    captured = capsys.readouterr()
    assert sentinel not in captured.out + captured.err
    assert "could not be parsed as YAML" in captured.err


def test_the_credential_never_reaches_a_repr():
    credential = Credential(token="super-secret", source="a test")
    assert "super-secret" not in repr(credential)


def test_the_cli_config_path_follows_the_cli_own_rules(monkeypatch, tmp_path):
    monkeypatch.setenv("RENDER_CLI_CONFIG_PATH", "/tmp/explicit.yaml")
    assert cli_config_path() == Path("/tmp/explicit.yaml")
    monkeypatch.delenv("RENDER_CLI_CONFIG_PATH")
    monkeypatch.setenv("RENDER_CLI_CONFIG_DIR", str(tmp_path))
    assert cli_config_path() == tmp_path / "cli.yaml"


@pytest.mark.parametrize(
    "saved",
    [
        "",  # nothing saved at all
        "https://api.render.com/v1/",  # the CLI's own default, trailing slash
        "https://api.render.com/v1",
        "https://api.render.com",
        "https://API.Render.com/v1",
    ],
)
def test_the_official_host_is_accepted_and_normalized(saved):
    assert official_api_host(saved, where="a test") == DEFAULT_API_HOST


@pytest.mark.parametrize(
    "saved",
    [
        "http://api.render.com/v1",  # a bearer token over plain HTTP
        "https://api.render.com.evil.example/v1",
        "https://evil.example/v1",
        "https://api.render.com@evil.example/v1",
        "https://someone:token@api.render.com/v1",
        "https://api.render.com:8443/v1",
        "https://api.render.com/v1/../../elsewhere",
        "https://api.render.com/v1?to=elsewhere",
        "https://api.render.com:notaport/v1",
        "api.render.com/v1",
        "file:///etc/passwd",
    ],
)
def test_an_off_origin_or_insecure_saved_host_is_refused(tmp_path, monkeypatch, saved):
    """``api.host`` is whatever was written into the credential file, and it
    becomes the URL a bearer token is sent to. This helper talks to the public
    Render API or to nothing, and its refusal does not echo the value back,
    because a URL is a fine place to hide a secret."""
    with pytest.raises(DeployError) as err:
        official_api_host(saved, where="a test")
    with pytest.raises(DeployError) as reference:
        official_api_host("https://not-render.example", where="a test")
    # one fixed sentence, whatever was in the file: nothing of the value is in it
    assert str(err.value) == str(reference.value)
    assert DEFAULT_API_HOST in str(err.value)
    assert "someone:token" not in str(err.value) and "evil.example" not in str(err.value)

    cli = _cli_config(
        tmp_path, f'api:\n  key: saved-token\n  expires_at: 99999999999\n  host: "{saved}"\n'
    )
    monkeypatch.setenv("RENDER_CLI_CONFIG_PATH", str(cli))
    monkeypatch.delenv("RENDER_API_KEY", raising=False)
    with pytest.raises(DeployError) as err:
        resolve_credential(now=1000)
    assert "saved-token" not in str(err.value)


def test_the_client_refuses_a_bad_host_before_it_opens_anything(monkeypatch):
    """The check happens before a client exists, let alone a request: if it were
    a request-time check, the first request would already have carried the token
    somewhere it does not belong."""
    def _never(*args, **kwargs):
        raise AssertionError("a client was built for a host that was refused")

    monkeypatch.setattr(httpx, "Client", _never)
    with pytest.raises(DeployError):
        RenderClient(Credential(token="t", source="a test", host="https://evil.example/v1"))


def test_a_workspace_is_required_and_never_guessed(tmp_path, monkeypatch):
    monkeypatch.setenv("RENDER_CLI_CONFIG_PATH", str(tmp_path / "absent.yaml"))
    monkeypatch.delenv("RENDER_WORKSPACE", raising=False)
    with pytest.raises(DeployError, match="workspace"):
        resolve_workspace()
    assert resolve_workspace("tea-explicit") == ("tea-explicit", "--workspace")
    monkeypatch.setenv("RENDER_WORKSPACE", "tea-env")
    assert resolve_workspace() == ("tea-env", "$RENDER_WORKSPACE")
    # explicit still wins, and the report says which source answered
    assert resolve_workspace("tea-explicit")[0] == "tea-explicit"


# --- push: the write, the deploy evidence, and doing nothing twice -----------


def test_a_first_push_writes_both_services_and_reports_each(tmp_path):
    render = _Render()
    report = _push(tmp_path, render)
    assert report.ok
    assert [o.name for o in report.outcomes] == list(SERVICE_NAMES)
    assert all(o.status == "updated" for o in report.outcomes)
    assert report.encoded_length == len(encode_source(example_text()))
    # exactly one single-key write per service, never a bulk replacement
    puts = [p for m, p in render.requests if m == "PUT"]
    assert len(puts) == 2
    assert all(p.endswith(f"/env-vars/{CONFIG_KEY}") for p in puts)
    assert render.env[WEB_ID][CONFIG_KEY] == encode_source(example_text())
    assert render.env[WORKER_ID][CONFIG_KEY] == encode_source(example_text())


def test_a_second_run_with_nothing_changed_writes_nothing_and_deploys_nothing(tmp_path):
    """Idempotence, demonstrated by the absence of requests rather than asserted."""
    render = _Render()
    _push(tmp_path, render)
    render.requests.clear()
    render.deployed.clear()

    report = _push(tmp_path, render)
    assert report.ok
    assert all(o.status == "unchanged" for o in report.outcomes)
    assert [m for m, _ in render.requests if m in ("PUT", "POST")] == []
    assert render.deployed == []
    assert all("no write, no deploy" in o.line() for o in report.outcomes)


def test_only_this_commands_own_variable_is_ever_read_or_written(tmp_path):
    """The single-variable endpoint, never the bulk listing. Listing would hand
    this command every other secret on the service in order to look at one key
    it already knows the name of."""
    render = _Render()
    before = {sid: dict(env) for sid, env in render.env.items()}
    report = _push(tmp_path, render)
    assert report.ok

    reads = [p for m, p in render.requests if m == "GET" and "/env-vars" in p]
    assert reads and all(p.endswith(f"/env-vars/{CONFIG_KEY}") for p in reads)
    assert not any("/env-vars" in p and not p.endswith(f"/env-vars/{CONFIG_KEY}")
                   for _m, p in render.requests)
    assert render.bulk_reads == []
    # and every other setting is exactly where it was
    for service_id, env in before.items():
        assert render.env[service_id] == {**env, CONFIG_KEY: encode_source(example_text())}


def test_a_value_past_the_first_page_of_a_listing_is_still_seen(tmp_path):
    """A service with more variables than one page holds. Read through the bulk
    listing, this command's key would not be on page one and would read as
    absent — which here means write it, and a write means a deploy. Asked for by
    name, it is simply there."""
    render = _Render(values={WEB_ID: encode_source(example_text()),
                             WORKER_ID: encode_source(example_text())})
    report = _push(tmp_path, render)
    assert all(o.status == "unchanged" for o in report.outcomes)
    assert [m for m, _ in render.requests if m in ("PUT", "POST")] == []


def test_a_variable_that_is_not_set_yet_reads_as_absent_rather_than_as_an_error(tmp_path):
    """404 is the documented answer for "this service has no such variable". It
    is an answer, and it means write."""
    render = _Render()
    assert CONFIG_KEY not in render.env[WEB_ID]
    report = _push(tmp_path, render)
    assert all(o.status == "updated" for o in report.outcomes)
    assert report.ok


def test_a_write_that_started_nothing_gets_one_requested(tmp_path):
    """Nothing new appeared during the write, so this command asks for a deploy
    and the answer names the one it created. That is the only deployment it can
    honestly connect to itself."""
    render = _Render()
    report = _push(tmp_path, render)
    assert report.ok
    assert all(o.deploy_source == "requested" for o in report.outcomes)
    assert render.deployed == [WEB_ID, WORKER_ID]
    for outcome in report.outcomes:
        assert outcome.deploy_id.startswith("dep-requested-")
        assert "so one was requested" in outcome.line()


def test_a_deploy_that_appears_during_the_write_is_not_claimed_as_this_one(tmp_path):
    """A deploy that was not there before the write is there now. Render's API
    says what a deploy is, never what caused it, so this is a coincidence in
    time and not evidence. It is reported as unproven, nothing is started on top
    of it, and the run does not pass."""
    render = _Render(deploy_during_write=frozenset(SERVICE_NAMES))
    report = _push(tmp_path, render)
    assert not report.ok
    assert render.deployed == []  # no second deploy over an unexplained one
    for outcome in report.outcomes:
        assert outcome.status == "updated"  # the value did reach the service
        assert outcome.deploy_source == "unknown"
        assert outcome.deploy_id.startswith("dep-concurrent-")
        assert "unproven" in outcome.detail
        assert "No second deploy was requested" in outcome.detail
        assert not outcome.settled


def test_a_pre_existing_unrelated_deploy_is_not_counted_as_this_one(tmp_path):
    """A deploy already running for another reason looks exactly like one this
    command caused, unless the before is read first."""
    render = _Render(deploys={WEB_ID: ["dep-unrelated-running"], WORKER_ID: ["dep-old"]})
    report = _push(tmp_path, render)
    web = next(o for o in report.outcomes if o.name == WEB_SERVICE)
    assert web.deploy_source == "requested"
    assert web.deploy_id != "dep-unrelated-running"
    assert WEB_ID in render.deployed


def test_a_deploy_request_that_names_nothing_is_uncertain_rather_than_done(tmp_path):
    render = _Render(nameless_deploy=frozenset({WORKER_SERVICE}))
    report = _push(tmp_path, render)
    assert not report.ok
    worker = next(o for o in report.outcomes if o.name == WORKER_SERVICE)
    assert worker.status == "updated" and worker.deploy_source == "unknown"
    assert "did not name one" in worker.detail
    web = next(o for o in report.outcomes if o.name == WEB_SERVICE)
    assert web.settled and web.deploy_source == "requested"


def test_a_suspended_service_is_written_but_never_woken(tmp_path):
    render = _Render(suspended=frozenset({WORKER_SERVICE}))
    report = _push(tmp_path, render)
    worker = next(o for o in report.outcomes if o.name == WORKER_SERVICE)
    assert worker.status == "updated" and worker.suspended
    assert WORKER_ID not in render.deployed
    assert "takes effect when it next wakes" in worker.line()
    assert render.env[WORKER_ID][CONFIG_KEY] == encode_source(example_text())
    assert worker.settled and report.ok
    # the awake one is unaffected by its neighbour's state
    web = next(o for o in report.outcomes if o.name == WEB_SERVICE)
    assert web.status == "updated" and not web.suspended


def test_every_service_page_is_read_before_deciding_a_name_is_unique(tmp_path):
    render = _Render(pages=2)
    report = _push(tmp_path, render)
    assert report.ok
    listings = [p for m, p in render.requests if p.endswith("/services")]
    assert len(listings) >= 4  # two pages per service


def test_a_short_page_does_not_hide_a_later_duplicate():
    render = _Render()
    cursors = []

    def listing(request):
        cursor = request.url.params.get("cursor")
        cursors.append(cursor)
        rows = {
            None: [render._entry(WEB_SERVICE, cursor="first")],
            "first": [render._entry(WEB_SERVICE, service_id="srv-second", cursor="last")],
            "last": [],
        }
        return httpx.Response(200, json=rows[cursor])

    client = RenderClient(
        Credential(token="test", source="test"),
        http=httpx.Client(transport=httpx.MockTransport(listing)),
    )
    with pytest.raises(DeployError, match="will not choose"):
        client.find_service(WEB_SERVICE, workspace=WORKSPACE)
    assert cursors == [None, "first", "last"]


def test_a_service_without_a_workspace_is_not_selected(tmp_path):
    render = _Render()
    original_entry = render._entry

    def missing_owner(*args, **kwargs):
        row = original_entry(*args, **kwargs)
        row["service"].pop("ownerId")
        return row

    render._entry = missing_owner
    report = _push(tmp_path, render)
    assert not report.ok
    assert all(outcome.status == "failed" for outcome in report.outcomes)
    assert all(method == "GET" for method, _ in render.requests)


@pytest.mark.parametrize("endless", ["advancing", "stuck"])
def test_a_listing_that_never_ends_is_stopped_rather_than_followed(tmp_path, endless):
    """A listing that always has one more page, or that hands back the same
    cursor forever, ends as an error. The alternative is a loop holding a bearer
    token."""
    render = _Render(endless=endless)
    report = _push(tmp_path, render)
    assert not report.ok
    for outcome in report.outcomes:
        assert outcome.status == "failed"
        assert "stopped rather than" in outcome.detail
    listings = [p for m, p in render.requests if p.endswith("/services")]
    assert len(listings) <= 2 * MAX_PAGES


def test_a_same_named_service_in_another_workspace_is_not_this_one(tmp_path):
    """The workspace is asked for and then checked again on every row. Everything
    after this point writes to whatever id comes out of it."""
    render = _Render(foreign=frozenset(SERVICE_NAMES))
    report = _push(tmp_path, render)
    assert report.ok  # one match, not two, and not the stranger
    assert [o.service_id for o in report.outcomes] == [WEB_ID, WORKER_ID]
    assert all("srv-elsewhere" not in p for _m, p in render.requests)


def test_two_services_with_one_name_stop_that_service_rather_than_guess(tmp_path):
    render = _Render(duplicates=frozenset({WORKER_SERVICE}))
    report = _push(tmp_path, render)
    assert not report.ok
    worker = next(o for o in report.outcomes if o.name == WORKER_SERVICE)
    assert worker.status == "failed"
    assert "will not choose between them" in worker.detail
    # and nothing was written to it
    assert CONFIG_KEY not in render.env[WORKER_ID]


def test_a_missing_service_is_named_rather_than_skipped(tmp_path):
    render = _Render(missing=frozenset({WEB_SERVICE}))
    report = _push(tmp_path, render)
    assert not report.ok
    web = next(o for o in report.outcomes if o.name == WEB_SERVICE)
    assert web.status == "failed" and "no service named" in web.detail


def test_one_service_failing_does_not_stop_the_other(tmp_path):
    """Partial failure is reported per service. A run that got one right and one
    wrong has to say exactly that."""
    render = _Render(missing=frozenset({WEB_SERVICE}))
    report = _push(tmp_path, render)
    outcomes = {o.name: o for o in report.outcomes}
    assert outcomes[WEB_SERVICE].status == "failed"
    assert outcomes[WORKER_SERVICE].status == "updated"
    assert render.env[WORKER_ID][CONFIG_KEY] == encode_source(example_text())
    assert not report.ok


def test_an_ambiguous_deploy_answer_is_reported_rather_than_called_success(tmp_path):
    """The value was written; whether a deploy followed could not be
    established. That is a third outcome, it says so, and it does not pass."""
    render = _Render(fail={("GET", "/deploys"): 500})
    report = _push(tmp_path, render)
    assert not report.ok
    for outcome in report.outcomes:
        assert outcome.status == "updated"
        assert outcome.deploy_source == "unknown"
        assert "could not be established" in outcome.detail
        assert "Check the service" in outcome.line()
    # the API's own words are not repeated back
    assert API_BODY_SENTINEL not in "\n".join(report.lines())


def test_a_write_that_got_no_answer_is_uncertain_and_never_repeated(tmp_path):
    """A PUT that times out may already have been applied. That is neither a
    failure nor a write to report, and a second attempt would be a second write
    — and, if the first one landed, a second deploy."""
    render = _Render(no_answer=frozenset({("PUT", "/env-vars/")}))
    report = _push(tmp_path, render)
    assert not report.ok
    for outcome in report.outcomes:
        assert outcome.status == "uncertain"
        assert outcome.deploy_source == "unknown"
        assert "whether the value reached this service is unknown" in outcome.detail
        assert "Check the service" in outcome.line()
        assert not outcome.settled
    assert len([p for m, p in render.requests if m == "PUT"]) == len(SERVICE_NAMES)
    assert render.deployed == []


def test_a_transport_failure_on_one_service_still_reports_the_other(tmp_path):
    """One service's network trouble is one service's outcome. It does not
    escape as an exception, abort the run and take the other service's result
    with it."""
    render = _Render(no_answer=frozenset({("GET", f"/services/{WEB_ID}/")}))
    report = _push(tmp_path, render)
    outcomes = {o.name: o for o in report.outcomes}
    assert outcomes[WEB_SERVICE].status == "failed"
    assert "got no answer" in outcomes[WEB_SERVICE].detail
    assert outcomes[WORKER_SERVICE].status == "updated" and outcomes[WORKER_SERVICE].settled
    assert render.env[WORKER_ID][CONFIG_KEY] == encode_source(example_text())
    assert not report.ok


def test_an_answer_that_is_not_json_is_refused_rather_than_guessed_at(tmp_path):
    render = _Render(garbled=frozenset({("GET", "/services")}))
    report = _push(tmp_path, render)
    assert not report.ok
    for outcome in report.outcomes:
        assert outcome.status == "failed"
        assert "could not read as JSON" in outcome.detail
    assert API_BODY_SENTINEL not in "\n".join(report.lines())


def test_a_changed_value_is_written_but_an_unrelated_variable_is_left_alone(tmp_path):
    """Only this command's own key is ever read or written: the other variables
    on these services are the secrets, and this command does not know them."""
    stale = base64.b64encode(b"schema = 1\n").decode()
    render = _Render(values={WEB_ID: stale, WORKER_ID: stale})
    report = _push(tmp_path, render)
    assert all(o.status == "updated" for o in report.outcomes)
    puts = [p for m, p in render.requests if m == "PUT"]
    assert all(p.endswith(f"/env-vars/{CONFIG_KEY}") for p in puts)
    assert not any(m == "PUT" and p.endswith("/env-vars") for m, p in render.requests)
    assert render.env[WEB_ID]["VAPID_PRIVATE_KEY"] == "vapid-secret"
    assert render.env[WORKER_ID]["CLAUDE_CODE_OAUTH_TOKEN"] == "claude-secret"


def test_the_report_names_lengths_and_outcomes_never_contents(tmp_path):
    render = _Render()
    report = _push(tmp_path, render, workspace_source="$RENDER_WORKSPACE")
    joined = "\n".join(report.lines())
    assert f"encoded length {report.encoded_length} bytes" in joined
    assert WORKSPACE in joined and "$RENDER_WORKSPACE" in joined
    # never the value, never the source text, never the token
    assert encode_source(example_text()) not in joined
    assert "test-key" not in joined
    for line in example_text().splitlines():
        if line.startswith("remote ="):
            assert line not in joined


def test_push_validates_before_it_reaches_the_network(tmp_path):
    """A source that could not boot never reaches a service."""
    render = _Render()
    bad = _source(tmp_path, "schema = 1\nprofile = \"pinboard\"\n")
    with pytest.raises(DeployError):
        push(bad, client=render.client(), workspace=WORKSPACE)
    assert render.requests == []


def test_validation_failure_is_a_config_error_turned_into_a_deploy_error(tmp_path):
    with pytest.raises(DeployError) as err:
        read_source(_source(tmp_path, "schema = 3\n"))
    assert "schema" in str(err.value)
    assert not isinstance(err.value, ConfigError)


# --- the command line ---------------------------------------------------------


def _cli(tmp_path, monkeypatch, render):
    monkeypatch.setenv("RENDER_API_KEY", "test-key")
    monkeypatch.setattr("paratrooper.deploy.RenderClient", lambda cred, **kw: render.client())
    return main(["push", str(_source(tmp_path)), "--workspace", WORKSPACE])


def test_a_completed_push_exits_zero(tmp_path, monkeypatch, capsys):
    render = _Render()
    assert _cli(tmp_path, monkeypatch, render) == 0
    out = capsys.readouterr().out
    assert "so one was requested" in out
    assert encode_source(example_text()) not in out and "test-key" not in out


def test_a_deployment_this_command_cannot_account_for_exits_non_zero(
    tmp_path, monkeypatch, capsys
):
    """The configuration only reaches a running service through a deploy. A run
    that wrote the value and cannot say what deployed it has not finished the
    job, and an exit code of zero would be the wrong kind of quiet."""
    render = _Render(deploy_during_write=frozenset(SERVICE_NAMES))
    assert _cli(tmp_path, monkeypatch, render) == 1
    out = capsys.readouterr().out
    assert "unproven" in out and "dep-concurrent" in out
    assert encode_source(example_text()) not in out and "test-key" not in out


def test_a_write_with_no_answer_exits_non_zero(tmp_path, monkeypatch, capsys):
    render = _Render(no_answer=frozenset({("PUT", "/env-vars/")}))
    assert _cli(tmp_path, monkeypatch, render) == 1
    out = capsys.readouterr().out
    assert "uncertain" in out
    assert encode_source(example_text()) not in out and "test-key" not in out
