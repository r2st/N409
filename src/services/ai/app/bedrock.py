"""Amazon Bedrock Runtime client — the second general-purpose completion provider.

Unlike `websearch.py`, which does a different *job*, this does the same job as
`openrouter.py` through a different door. That is the whole point of it: it is a
deployment-topology choice, not a capability one (design §12.2, P2-21).

The choice it exists to serve is data residency and procurement. A firm that has
already put its AWS account through review, and whose counsel has signed off on
Bedrock's terms, cannot route a confidential 409A through a third-party
aggregator no matter how good the models are — and telling them "use a different
platform" is the only other answer. With this adapter the same prompts run
inside their own AWS account, in a region they name, under an IAM role they
control, with model invocation logged where their auditors already look.

**No boto3.** Bedrock's Converse API is one signed POST, and SigV4 is ~40 lines
of hmac. Adding boto3 to this service would pull botocore, s3transfer and
jmespath into an image whose entire dependency list is currently four packages,
to call one endpoint. The signing here is the documented algorithm and is tested
against the AWS specification's own worked example.

Credentials are read from the environment only. There is deliberately no
instance-metadata or profile lookup: this service runs as a systemd unit on a
host that is not necessarily in AWS, and a credential chain that silently
succeeds by picking up an unrelated role is worse than one that fails loudly.

Configuration:
    BEDROCK_REGION            e.g. us-east-1 (required to enable the provider)
    AWS_ACCESS_KEY_ID         required
    AWS_SECRET_ACCESS_KEY     required
    AWS_SESSION_TOKEN         optional; set when using temporary credentials
    BEDROCK_MODEL             default model id, e.g. anthropic.claude-sonnet-4-20250514-v1:0
    BEDROCK_MAX_TOKENS        per-call output ceiling
    BEDROCK_CALL_BUDGET_S     whole-call wall clock; 0 disables
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import hmac
import json
import logging
import os
import threading
import time
import urllib.parse
from dataclasses import dataclass

import httpx

from .llm_http import (
    MAX_RETRIES,
    TRUNCATED_FINISH_REASONS,
    BudgetExhausted as _BudgetExhausted,
    Deadline,
    DeadlineExceeded as _BaseDeadlineExceeded,
    TokenLedger,
    backoff_sleep,
    env_float,
    env_int,
    estimate_tokens,
    stop_reason as _read_stop_reason,
    token_count,
)
from .openrouter import LlmResult

SERVICE = "bedrock"
ALGORITHM = "AWS4-HMAC-SHA256"

#: The prefix that routes a model id here rather than to OpenRouter. A model
#: id is the only routing signal the prompt registry carries, so the provider
#: has to be legible in it — `bedrock/anthropic.claude-...`.
MODEL_PREFIX = "bedrock/"

DEFAULT_MODEL = "anthropic.claude-sonnet-4-20250514-v1:0"
DEFAULT_MAX_TOKENS = 2000
DEFAULT_CALL_BUDGET_S = 150.0
KEY_CHECK_TIMEOUT_S = 10.0
#: /ready is polled constantly; a minute of staleness is fine for readiness.
KEY_CHECK_TTL_S = 60.0

_RETRYABLE_HTTP_EXC = (httpx.TransportError,)

_log = logging.getLogger("bedrock")


class BedrockError(Exception):
    """Raised when a Bedrock completion cannot be produced."""


class BedrockNotConfigured(BedrockError):
    """Raised when a Bedrock model is asked for and no credentials are set."""


class DeadlineExceeded(BedrockError, _BaseDeadlineExceeded):
    """Raised when the whole-call budget ran out before Bedrock answered."""


class TokenBudgetExceeded(BedrockError):
    """Raised when BEDROCK_TOKEN_BUDGET is spent."""


#: This provider's share of the process's spend, and its own ceiling.
#:
#: Bedrock had neither. `OPENROUTER_TOKEN_BUDGET` is documented as the guard
#: against a runaway loop "once a paid key is configured", and every Bedrock
#: invocation is billed to the operator's own AWS account — so the one provider
#: whose spend is certain was the one outside the ledger. `/ready`'s
#: `tokens_used` reported zero for an installation routing every prompt here,
#: and no ceiling anywhere would have stopped a loop doing it.
_budget = TokenLedger("BEDROCK_TOKEN_BUDGET")


def tokens_used() -> int:
    """Cumulative Bedrock tokens consumed by this process (surfaced on /ready)."""
    return _budget.used


# ── Configuration ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Credentials:
    access_key: str
    secret_key: str
    session_token: str | None
    region: str


def credentials() -> Credentials | None:
    """The configured credentials, or None when Bedrock is not in use.

    All four parts or none. A half-configured provider — a region with no key,
    a key with no region — is a misconfiguration that should read as "off"
    rather than fail at the first prompt that happens to route here.
    """
    region = os.environ.get("BEDROCK_REGION", "").strip()
    access_key = os.environ.get("AWS_ACCESS_KEY_ID", "").strip()
    secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY", "").strip()
    if not (region and access_key and secret_key):
        return None
    token = os.environ.get("AWS_SESSION_TOKEN", "").strip() or None
    return Credentials(access_key, secret_key, token, region)


def is_configured() -> bool:
    return credentials() is not None


def default_model() -> str:
    return os.environ.get("BEDROCK_MODEL", "").strip() or DEFAULT_MODEL


def configured_models() -> list[str]:
    """Bedrock candidates, prefixed, for the model picker. Empty when off.

    One entry, not a fallback chain. OpenRouter's list exists because free
    tiers rate-limit and falling through keeps the pipelines usable; every
    Bedrock invocation is billed to the operator's own account, so falling
    through on a failure would quietly spend more of their money to paper over
    a bad request.
    """
    return [f"{MODEL_PREFIX}{default_model()}"] if is_configured() else []


def max_output_tokens() -> int:
    return env_int("BEDROCK_MAX_TOKENS", DEFAULT_MAX_TOKENS)


def call_budget_s() -> float:
    return env_float("BEDROCK_CALL_BUDGET_S", DEFAULT_CALL_BUDGET_S)


def handles(model: str | None) -> bool:
    """Whether this provider owns the given model id."""
    return bool(model) and model.startswith(MODEL_PREFIX)  # type: ignore[union-attr]


def strip_prefix(model: str) -> str:
    """`bedrock/anthropic.claude-x` → `anthropic.claude-x`."""
    return model[len(MODEL_PREFIX) :] if model.startswith(MODEL_PREFIX) else model


def endpoint(region: str) -> str:
    return f"https://bedrock-runtime.{region}.amazonaws.com"


# ── SigV4 ────────────────────────────────────────────────────────────────────
#
# The documented algorithm, implemented directly. Every step is spelled out
# rather than folded together because a signature that is wrong is wrong with a
# 403 and no indication of which step drifted.


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def signing_key(secret: str, date_stamp: str, region: str, service: str) -> bytes:
    """The derived key: kDate → kRegion → kService → kSigning."""
    k_date = _hmac(f"AWS4{secret}".encode("utf-8"), date_stamp)
    k_region = _hmac(k_date, region)
    k_service = _hmac(k_region, service)
    return _hmac(k_service, "aws4_request")


def sign_request(
    creds: Credentials,
    *,
    method: str,
    path: str,
    body: bytes,
    now: _dt.datetime,
    host: str | None = None,
) -> dict[str, str]:
    """Headers for one signed Bedrock request.

    `path` is signed already-encoded: a Bedrock model id contains a colon
    (`...-v1:0`) which must appear percent-encoded in both the URL and the
    canonical request, and encoding it in one place only is the single most
    likely way to get a working signature for most models and a 403 for the
    versioned ones.
    """
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    host = host or f"bedrock-runtime.{creds.region}.amazonaws.com"
    payload_hash = _sha256_hex(body)

    headers: dict[str, str] = {
        "content-type": "application/json",
        "host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    if creds.session_token:
        headers["x-amz-security-token"] = creds.session_token

    signed_headers = ";".join(sorted(headers))
    canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
    canonical_request = "\n".join(
        [method, path, "", canonical_headers, signed_headers, payload_hash]
    )

    scope = f"{date_stamp}/{creds.region}/{SERVICE}/aws4_request"
    string_to_sign = "\n".join(
        [ALGORITHM, amz_date, scope, _sha256_hex(canonical_request.encode("utf-8"))]
    )
    signature = hmac.new(
        signing_key(creds.secret_key, date_stamp, creds.region, SERVICE),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    headers["authorization"] = (
        f"{ALGORITHM} Credential={creds.access_key}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return headers


def converse_path(model_id: str) -> str:
    """The Converse path with the model id percent-encoded exactly once."""
    return f"/model/{urllib.parse.quote(model_id, safe='')}/converse"


# ── Response shape ───────────────────────────────────────────────────────────


def completion_text(data: dict) -> str:
    """The assistant text out of a Converse response, or "" if it is not there.

    Every level is provider-controlled, so none of it is assumed — same
    discipline as `openrouter._completion_text`. Converse returns content as a
    *list* of blocks (text, tool use, reasoning), so the text blocks are joined
    rather than the first one taken: a model that opens with a reasoning block
    would otherwise read as an empty completion.
    """
    output = data.get("output")
    if not isinstance(output, dict):
        return ""
    message = output.get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if not isinstance(content, list):
        return ""
    parts = [
        block["text"]
        for block in content
        if isinstance(block, dict) and isinstance(block.get("text"), str)
    ]
    return "".join(parts)


def _stop_reason(data: dict) -> str | None:
    """Why the model stopped, if it said — Converse's `stopReason`.

    `LlmResult.finish_reason` was left at its default here, and everything that
    asks whether an answer is whole reads it: `pipelines._safe_result` raises on
    a truncated JSON reply instead of filing the fragment under `notes` and
    reporting success, and `research.fallback_research` discards a write-up cut
    off mid-sentence rather than storing it `grounded` for a report to quote.
    Both of those guards were written against the chat-completions spelling, so
    a prompt bound to a `bedrock/` model got every one of them answering False —
    not because the answer was whole, but because nobody had asked.
    """
    return _read_stop_reason(data)


def _usage(data: dict) -> tuple[int, int]:
    usage = data.get("usage")
    usage = usage if isinstance(usage, dict) else {}
    return token_count(usage.get("inputTokens")), token_count(usage.get("outputTokens"))


def _error_message(resp: httpx.Response) -> str:
    """Bedrock's error body, when it has one, else the status line."""
    try:
        body = resp.json()
    except ValueError:
        return f"HTTP {resp.status_code} {resp.text[:200]}"
    if isinstance(body, dict):
        message = body.get("message") or body.get("Message")
        if isinstance(message, str) and message:
            return f"HTTP {resp.status_code}: {message}"
    return f"HTTP {resp.status_code} {resp.text[:200]}"


# ── Credential verification ──────────────────────────────────────────────────

_key_lock = threading.Lock()
_key_cache: tuple[str, float, "KeyStatus"] | None = None


@dataclass(frozen=True)
class KeyStatus:
    """Outcome of verifying the Bedrock credentials.

    States mirror `openrouter.KeyStatus` so `/ready` can report both the same
    way: ``valid``, ``missing``, ``invalid`` (AWS rejected the signature or the
    role lacks `bedrock:InvokeModel`), ``unreachable``.
    """

    state: str
    detail: str

    @property
    def ok(self) -> bool:
        return self.state == "valid"


def reset_budget() -> None:
    """Drop the running token total (tests only)."""
    _budget.reset()


def reset_key_cache() -> None:
    global _key_cache
    with _key_lock:
        _key_cache = None


def _cached(fingerprint: str) -> KeyStatus | None:
    with _key_lock:
        if (
            _key_cache is not None
            and _key_cache[0] == fingerprint
            and time.monotonic() - _key_cache[1] < KEY_CHECK_TTL_S
        ):
            return _key_cache[2]
    return None


def verify_credentials(
    *, client: httpx.Client | None = None, force: bool = False
) -> KeyStatus:
    """Prove the credentials by listing the account's foundation models.

    A read-only control-plane call rather than a token-burning completion: it
    is free, it needs no model to be enabled, and — this is the part that
    matters — it distinguishes "the signature is wrong" from "the signature is
    fine and this account cannot use this model", which are different tickets
    for whoever is reading /ready.
    """
    creds = credentials()
    if creds is None:
        return KeyStatus("missing", "BEDROCK_REGION and AWS credentials are not all set")

    fingerprint = f"{creds.region}:{creds.access_key}:{creds.session_token or ''}"
    if not force:
        cached = _cached(fingerprint)
        if cached is not None:
            return cached

    owns_client = client is None
    http = client or httpx.Client(timeout=KEY_CHECK_TIMEOUT_S)
    try:
        path = "/foundation-models"
        host = f"bedrock.{creds.region}.amazonaws.com"
        headers = sign_request(
            creds,
            method="GET",
            path=path,
            body=b"",
            now=_dt.datetime.now(_dt.timezone.utc),
            host=host,
        )
        try:
            resp = http.get(f"https://{host}{path}", headers=headers)
        except httpx.HTTPError as exc:
            status = KeyStatus("unreachable", f"could not reach Bedrock: {exc}")
        else:
            if resp.status_code == 200:
                status = KeyStatus("valid", f"Bedrock accepted credentials in {creds.region}")
            elif resp.status_code in (400, 401, 403):
                status = KeyStatus("invalid", f"Bedrock rejected the credentials: {_error_message(resp)}")
            else:
                status = KeyStatus("unreachable", f"unexpected {_error_message(resp)}")
    finally:
        if owns_client:
            http.close()

    global _key_cache
    with _key_lock:
        _key_cache = (fingerprint, time.monotonic(), status)
    return status


# ── The call ─────────────────────────────────────────────────────────────────


def _converse_body(system: str, user: str) -> dict:
    return {
        "system": [{"text": system}],
        "messages": [{"role": "user", "content": [{"text": user}]}],
        "inferenceConfig": {"maxTokens": max_output_tokens(), "temperature": 0.1},
    }


def _post_with_retry(
    http: httpx.Client,
    creds: Credentials,
    model_id: str,
    system: str,
    user: str,
    deadline: Deadline,
) -> httpx.Response:
    """One model, retrying transport errors and 5xx within the call budget.

    Signed per attempt rather than once: a SigV4 signature is bound to its
    x-amz-date and AWS rejects one more than fifteen minutes old, so a retry
    after a long backoff has to be re-signed or it fails as a 403 that looks
    like a credentials problem.
    """
    path = converse_path(model_id)
    url = f"{endpoint(creds.region)}{path}"
    body = json.dumps(_converse_body(system, user)).encode("utf-8")

    last_exc: httpx.HTTPError | None = None
    for attempt in range(MAX_RETRIES + 1):
        if deadline.expired():
            raise last_exc if last_exc else DeadlineExceeded(f"{model_id}: call budget exhausted")
        headers = sign_request(
            creds, method="POST", path=path, body=body, now=_dt.datetime.now(_dt.timezone.utc)
        )
        try:
            resp = http.post(url, headers=headers, content=body, timeout=deadline.attempt_timeout())
        except _RETRYABLE_HTTP_EXC as exc:
            last_exc = exc
            if attempt < MAX_RETRIES and backoff_sleep(attempt, deadline):
                _log.warning(
                    "bedrock connect error, retrying",
                    extra={"event": "llm_retry", "model": model_id, "attempt": attempt},
                )
                continue
            raise
        if resp.status_code >= 500 and attempt < MAX_RETRIES and backoff_sleep(attempt, deadline):
            _log.warning(
                "bedrock 5xx, retrying",
                extra={
                    "event": "llm_retry",
                    "model": model_id,
                    "attempt": attempt,
                    "status": resp.status_code,
                },
            )
            continue
        return resp
    raise last_exc if last_exc else BedrockError(f"{model_id}: retries exhausted")


def chat(
    system: str, user: str, *, model: str | None = None, client: httpx.Client | None = None
) -> LlmResult:
    """Run one prompt against Bedrock. Same contract as `openrouter.chat`.

    Returns `openrouter.LlmResult` rather than a type of its own: the callers
    read `.model` and `.content` and record the token counts, and a second
    result type would make every one of them branch on which provider answered.

    One model, no fallback chain — see `configured_models`. A failure raises
    with the provider's own message, because on a billed provider the useful
    outcome of a bad request is the error, not a quieter second attempt.
    """
    creds = credentials()
    if creds is None:
        raise BedrockNotConfigured(
            "Bedrock is not configured (BEDROCK_REGION and AWS credentials required)"
        )
    # Fail fast before spending anything if the ceiling is already reached.
    try:
        _budget.check()
    except _BudgetExhausted as exc:
        raise TokenBudgetExceeded(str(exc)) from exc

    model_id = strip_prefix(model) if model else default_model()
    owns_client = client is None
    http = client or httpx.Client(timeout=KEY_CHECK_TIMEOUT_S)
    deadline = Deadline(call_budget_s())
    try:
        try:
            resp = _post_with_retry(http, creds, model_id, system, user, deadline)
        except _BaseDeadlineExceeded as exc:
            raise DeadlineExceeded(f"{model_id}: {exc}") from exc
        except httpx.HTTPError as exc:
            raise BedrockError(f"{model_id}: {exc}") from exc

        if resp.status_code != 200:
            raise BedrockError(f"{model_id}: {_error_message(resp)}")
        try:
            data = resp.json()
        except ValueError as exc:
            raise BedrockError(f"{model_id}: non-JSON body ({exc})") from exc
        if not isinstance(data, dict):
            raise BedrockError(f"{model_id}: non-object body ({type(data).__name__})")

        content = completion_text(data)
        if not content:
            raise BedrockError(f"{model_id}: empty completion")

        prompt_tokens, completion_tokens = _usage(data)
        # A response that reported no usage still spent something. The estimate
        # goes to the ledger only — `LlmResult` keeps the counters exactly as
        # they arrived, so nothing downstream can mistake a guess for a
        # measurement. Same rule, and the same reason, as `openrouter.chat`.
        self_total = prompt_tokens + completion_tokens
        estimated = self_total == 0
        billed = estimate_tokens(system, user, content) if estimated else self_total
        cumulative = _budget.add(billed)
        finish_reason = _stop_reason(data)
        if finish_reason in TRUNCATED_FINISH_REASONS:
            # The operator who has to raise BEDROCK_MAX_TOKENS has no other way
            # to learn that it is being hit; the caller may still accept the
            # answer, so this is a line rather than a raise.
            _log.warning(
                "llm completion truncated at the output cap",
                extra={
                    "event": "llm_truncated",
                    "model": f"{MODEL_PREFIX}{model_id}",
                    "tokens": max_output_tokens(),
                    "detail": finish_reason,
                },
            )
        _log.info(
            "llm usage",
            extra={
                "event": "llm_usage",
                "model": f"{MODEL_PREFIX}{model_id}",
                "tokens": billed,
                "tokens_total": cumulative,
                "detail": "estimated" if estimated else "reported",
            },
        )
        return LlmResult(
            # Prefixed on the way out as well as in: this string lands in job
            # records and audit trails, and "which provider produced this
            # answer" is exactly the question those exist to answer.
            model=f"{MODEL_PREFIX}{model_id}",
            content=content,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            finish_reason=finish_reason,
        )
    finally:
        if owns_client:
            http.close()
