#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL must point to a disposable PostgreSQL database with submitted synthetic referral evidence}"
pass=0
check_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1)); printf 'PASS  %s — %s\n' "$label" "$actual"
  else
    printf 'FAIL  %s — expected %s, got %s\n' "$label" "$expected" "$actual" >&2; exit 1
  fi
}
check_true() {
  local label="$1" condition="$2" detail="$3"
  if [[ "$condition" == "1" ]]; then
    pass=$((pass + 1)); printf 'PASS  %s — %s\n' "$label" "$detail"
  else
    printf 'FAIL  %s — %s\n' "$label" "$detail" >&2; exit 1
  fi
}
psql_at() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -qAtc "$1"; }

version="$(psql_at 'SHOW server_version_num')"
check_true 'PostgreSQL 17 or newer is running' "$((version >= 170000 ? 1 : 0))" "$version"
check_eq 'migration 20260920_009 is checksummed once' "$(psql_at "SELECT count(*) FROM voxera_schema_migrations WHERE id='20260920_009_public_referral_forms' AND length(checksum)=64")" '1'
check_eq 'all five public-referral indexes exist' "$(psql_at "SELECT count(*) FROM pg_indexes WHERE schemaname=current_schema() AND indexname = ANY (ARRAY['voxera_docs_referral_form_slug','voxera_docs_referral_submission_token','voxera_docs_referral_submission_referral','voxera_docs_referral_form_state','voxera_docs_referral_submission_queue'])")" '5'
check_eq 'both submitted-evidence triggers exist' "$(psql_at "SELECT count(*) FROM pg_trigger WHERE tgrelid='voxera_docs'::regclass AND NOT tgisinternal AND tgname = ANY (ARRAY['voxera_submitted_referral_evidence_update','voxera_submitted_referral_evidence_delete'])")" '2'
check_eq 'submitted-evidence trigger function exists' "$(psql_at "SELECT count(*) FROM pg_proc WHERE proname='voxera_reject_submitted_referral_evidence_change'")" '1'

before="$(psql_at "SELECT count(*) FROM voxera_docs WHERE collection='referralFormSubmissions' AND body->>'status'='submitted'")"
check_true 'disposable store contains submitted synthetic evidence' "$((before > 0 ? 1 : 0))" "$before row(s)"

update_log="$(mktemp)"; delete_log="$(mktemp)"
trap 'rm -f "$update_log" "$delete_log"' EXIT
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -c "UPDATE voxera_docs SET body=body WHERE seq=(SELECT seq FROM voxera_docs WHERE collection='referralFormSubmissions' AND body->>'status'='submitted' ORDER BY seq DESC LIMIT 1)" >"$update_log" 2>&1; then
  printf 'FAIL  direct update unexpectedly changed submitted evidence\n' >&2; exit 1
fi
check_true 'direct submitted-evidence update is rejected' "$(grep -qi 'submitted referral evidence is immutable' "$update_log" && echo 1 || echo 0)" 'SQLSTATE trigger rejection observed'
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -c "DELETE FROM voxera_docs WHERE seq=(SELECT seq FROM voxera_docs WHERE collection='referralFormSubmissions' AND body->>'status'='submitted' ORDER BY seq DESC LIMIT 1)" >"$delete_log" 2>&1; then
  printf 'FAIL  direct delete unexpectedly removed submitted evidence\n' >&2; exit 1
fi
check_true 'direct submitted-evidence delete is rejected' "$(grep -qi 'submitted referral evidence is immutable' "$delete_log" && echo 1 || echo 0)" 'SQLSTATE trigger rejection observed'
check_eq 'all submitted evidence remains after tamper attempts' "$(psql_at "SELECT count(*) FROM voxera_docs WHERE collection='referralFormSubmissions' AND body->>'status'='submitted'")" "$before"

printf '\npublic-referrals-postgres-check: %d assertions passed\n' "$pass"
