# Synthetic CI fixture

`voxera-ci.sqlite.gz` is a compressed, synthetic Northwind demo workspace used
only by regression jobs. A fresh Git checkout has no writable `data/` database;
CI restores this fixture with:

```bash
python3 scripts/restore-ci-fixture.py --replace
```

The restore streams and verifies `voxera-ci.sqlite.sha256`, runs SQLite integrity
checks and requires exactly one known synthetic demo owner before replacing the
target. `data/`, fixtures and all demo credentials are excluded from the Docker
build context, so the production image starts with a fresh PostgreSQL database
and never ships this fixture.

The fixture contains generated people, addresses, phone numbers, calls, messages,
bookings and money rows. It must never contain real customer/patient/provider
records or live secrets. Replacing it requires a new checksum and the complete
local PostgreSQL/live/offline/browser acceptance suite.
