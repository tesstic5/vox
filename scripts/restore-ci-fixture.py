#!/usr/bin/env python3
"""Restore the tracked synthetic CI fixture after verifying its SHA-256.

The production image excludes fixtures and data. This script exists so a fresh
Git checkout can run the regression suites without committing the writable demo
database. Replacing an existing target requires the explicit --replace flag.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import os
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "fixtures" / "voxera-ci.sqlite.gz"
CHECKSUM = ROOT / "fixtures" / "voxera-ci.sqlite.sha256"

parser = argparse.ArgumentParser()
parser.add_argument("--target", default=str(ROOT / "data" / "voxera-db.sqlite"))
parser.add_argument("--replace", action="store_true")
args = parser.parse_args()

target = Path(args.target).resolve()
if target.exists() and not args.replace:
    print(f"refusing to replace existing fixture target without --replace: {target}", file=sys.stderr)
    raise SystemExit(2)
if not ARCHIVE.exists() or not CHECKSUM.exists():
    print("tracked CI fixture or checksum is missing", file=sys.stderr)
    raise SystemExit(2)

expected = CHECKSUM.read_text().split()[0].lower()
target.parent.mkdir(parents=True, exist_ok=True)
tmp = target.with_suffix(target.suffix + ".fixture-tmp")
tmp_sidecars = [Path(str(tmp) + suffix) for suffix in ("-wal", "-shm")]
hash_ = hashlib.sha256()
try:
    with gzip.open(ARCHIVE, "rb") as source, tmp.open("wb") as destination:
        while chunk := source.read(1024 * 1024):
            hash_.update(chunk)
            destination.write(chunk)
        destination.flush()
        os.fsync(destination.fileno())
    actual = hash_.hexdigest()
    if actual != expected:
        raise RuntimeError(f"fixture checksum mismatch: expected {expected}, got {actual}")

    connection = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    docs = connection.execute("SELECT count(*) FROM docs").fetchone()[0]
    collections = connection.execute("SELECT count(DISTINCT collection) FROM docs").fetchone()[0]
    demo = connection.execute(
        "SELECT count(*) FROM docs WHERE collection='users' AND json_extract(body,'$.email')='jordan@northwind.dev'"
    ).fetchone()[0]
    connection.close()
    for sidecar in tmp_sidecars:
        sidecar.unlink(missing_ok=True)
    if integrity != "ok" or docs < 1 or collections < 1 or demo != 1:
        raise RuntimeError(f"fixture validation failed: integrity={integrity}, docs={docs}, collections={collections}, demo={demo}")

    for suffix in ("-wal", "-shm"):
        Path(str(target) + suffix).unlink(missing_ok=True)
    os.replace(tmp, target)
    print(f"restored verified synthetic CI fixture: {docs} documents across {collections} collections")
    print(f"SHA-256 {actual}")
except Exception as error:
    tmp.unlink(missing_ok=True)
    for sidecar in tmp_sidecars:
        sidecar.unlink(missing_ok=True)
    print(str(error), file=sys.stderr)
    raise SystemExit(1)
