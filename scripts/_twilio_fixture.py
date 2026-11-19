"""Isolated Twilio-stub carrier/number fixture for live HTTP gates.

The fixture never borrows an arbitrary connected carrier. It uses only the known
stub Account SID, creates that connection when absent, and gives back only the
number/carrier it created. A gate pointed at a real deployment therefore fails
rather than silently sending probe traffic through a customer's account.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable

Request = Callable[[str, str, dict | None], tuple[int, dict]]

STUB_SID = os.environ.get("TWILIO_STUB_SID", "AC" + "0123456789abcdef0123456789abcdef")
STUB_TOKEN = os.environ.get("TWILIO_STUB_TOKEN", "stub-auth-token")


def _masked(sid: str) -> str:
    return f"{sid[:6]}••••{sid[-3:]}" if len(sid) > 8 else "••••"


@dataclass
class TwilioFixture:
    carrier_id: str
    number_id: str
    number: str
    auth_token: str = STUB_TOKEN
    created_carrier: bool = False
    created_number: bool = False
    purchased_number: bool = False

    def cleanup(self, request: Request) -> list[str]:
        """Detach/release what this fixture created, then disconnect its carrier."""
        errors: list[str] = []
        if self.created_number and self.number_id:
            status, payload = request(
                "POST",
                f"/api/v1/phone-numbers/{self.number_id}/release",
                {"atCarrier": self.purchased_number},
            )
            if status != 200:
                errors.append(f"number cleanup returned {status}: {payload}")
        if self.created_carrier and self.carrier_id:
            status, payload = request("DELETE", f"/api/v1/carriers/{self.carrier_id}", None)
            if status != 200:
                errors.append(f"carrier cleanup returned {status}: {payload}")
        return errors


def ensure_twilio_fixture(request: Request, *, assistant_id: str | None = None, label: str = "runtime probe") -> TwilioFixture:
    """Return one active stub-backed E.164 line, creating isolated state if needed."""
    status, carriers_payload = request("GET", "/api/v1/carriers", None)
    if status != 200:
        raise RuntimeError(f"carrier list returned {status}: {carriers_payload}")

    carriers = carriers_payload.get("data") or []
    expected_mask = _masked(STUB_SID)
    carrier = next(
        (
            row
            for row in carriers
            if row.get("provider") == "twilio"
            and row.get("accountSid") == expected_mask
            and row.get("verified") is True
        ),
        None,
    )
    created_carrier = False
    if not carrier:
        status, carrier = request(
            "POST",
            "/api/v1/carriers",
            {
                "provider": "twilio",
                "accountSid": STUB_SID,
                "authToken": STUB_TOKEN,
                "label": label,
            },
        )
        if status != 201 or not carrier.get("id"):
            if carriers:
                raise RuntimeError(
                    "no verified Twilio stub carrier is connected; refusing to borrow an arbitrary carrier "
                    f"({status}: {carrier})"
                )
            raise RuntimeError(f"could not connect the Twilio stub carrier ({status}: {carrier})")
        created_carrier = True

    carrier_id = str(carrier.get("id") or "")
    status, local_payload = request("GET", "/api/v1/phone-numbers", None)
    if status != 200:
        raise RuntimeError(f"number list returned {status}: {local_payload}")
    local = [
        row
        for row in (local_payload.get("data") or [])
        if row.get("carrierId") == carrier_id and row.get("status") not in {"released", "released_at_carrier", "detached_at_carrier"}
    ]
    suitable = next(
        (
            row
            for row in local
            if not assistant_id or row.get("assistantId") == assistant_id
        ),
        None,
    )
    if suitable:
        # A prior probe may have crashed before its finally block. Reclaim only
        # unmistakably probe-labelled state; never treat a customer's ordinary
        # stub/test carrier as ours merely because the SID matches.
        label_text = str(carrier.get("label") or "").lower()
        stale_probe = any(label_text.startswith(prefix) for prefix in ("messaging probe", "recall probe", "manage probe", "booking probe", "money loop probe", "runtime probe"))
        return TwilioFixture(
            carrier_id=carrier_id,
            number_id=str(suitable.get("id") or ""),
            number=str(suitable.get("number") or ""),
            created_carrier=created_carrier or stale_probe,
            created_number=stale_probe,
            purchased_number=stale_probe and not bool(suitable.get("imported")),
        )

    # Prefer adopting a number the stub already owns. This does not create a
    # rental and cleanup can restore its previous callback configuration.
    status, owned_payload = request("GET", f"/api/v1/carriers/{carrier_id}/numbers?mode=owned&limit=30", None)
    if status != 200:
        raise RuntimeError(f"owned-number list returned {status}: {owned_payload}")
    for owned in owned_payload.get("data") or []:
        if owned.get("adopted"):
            continue
        status, adopted = request(
            "POST",
            f"/api/v1/carriers/{carrier_id}/numbers",
            {
                "number": owned.get("number"),
                "sid": owned.get("sid"),
                "label": label,
                **({"assistantId": assistant_id} if assistant_id else {}),
            },
        )
        if status == 201 and (adopted.get("number") or {}).get("id"):
            row = adopted["number"]
            return TwilioFixture(
                carrier_id=carrier_id,
                number_id=str(row["id"]),
                number=str(row["number"]),
                created_carrier=created_carrier,
                created_number=True,
                purchased_number=False,
            )

    # A parallel gate or another workspace may already hold every owned number.
    # Buy one from the deterministic stub pool and release it during cleanup.
    status, available_payload = request("GET", f"/api/v1/carriers/{carrier_id}/numbers?mode=available&country=US&limit=10", None)
    if status != 200:
        raise RuntimeError(f"available-number search returned {status}: {available_payload}")
    for candidate in available_payload.get("data") or []:
        number = str(candidate.get("number") or "")
        status, purchased = request(
            "POST",
            f"/api/v1/carriers/{carrier_id}/purchase",
            {
                "number": number,
                "label": label,
                **({"assistantId": assistant_id} if assistant_id else {}),
            },
        )
        if status == 201 and (purchased.get("number") or {}).get("id"):
            row = purchased["number"]
            return TwilioFixture(
                carrier_id=carrier_id,
                number_id=str(row["id"]),
                number=str(row["number"]),
                created_carrier=created_carrier,
                created_number=True,
                purchased_number=True,
            )

    # Avoid leaving a carrier created by a failed setup.
    if created_carrier:
        request("DELETE", f"/api/v1/carriers/{carrier_id}", None)
    raise RuntimeError("the Twilio stub exposed no number that could be safely adopted or purchased")
