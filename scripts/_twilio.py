"""Twilio webhook signatures for live-route gates."""

import base64
import hashlib
import hmac
import os


def public_base(request_base: str) -> str:
    return os.environ.get("VOXERA_PUBLIC_URL", request_base).rstrip("/")


def signature(request_base: str, path: str, params: dict, token: str | None = None) -> str:
    secret = (token or os.environ.get("STUB_TOKEN") or os.environ.get("TWILIO_STUB_TOKEN") or "stub-auth-token").encode()
    url = f"{public_base(request_base)}{path}"
    payload = url + "".join(f"{key}{params[key]}" for key in sorted(params))
    digest = hmac.new(secret, payload.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def headers(request_base: str, path: str, params: dict, token: str | None = None) -> dict[str, str]:
    return {"x-twilio-signature": signature(request_base, path, params, token)}


def direct_headers(url_base: str, path: str, params: dict, token: str | None = None) -> dict[str, str]:
    """Sign an explicit origin, bypassing VOXERA_PUBLIC_URL (negative tests)."""
    secret = (token or os.environ.get("STUB_TOKEN") or os.environ.get("TWILIO_STUB_TOKEN") or "stub-auth-token").encode()
    url = f"{url_base.rstrip('/')}{path}"
    payload = url + "".join(f"{key}{params[key]}" for key in sorted(params))
    digest = hmac.new(secret, payload.encode(), hashlib.sha1).digest()
    return {"x-twilio-signature": base64.b64encode(digest).decode()}


# Descriptive alias used by the newer gates; keep `headers` for older callers.
twilio_headers = headers
