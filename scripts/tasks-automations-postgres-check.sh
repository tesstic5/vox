#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL must point to a disposable PostgreSQL task/automation database}"
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
check_eq 'migration 20260920_010 has its exact PostgreSQL checksum' "$(psql_at "SELECT count(*) FROM voxera_schema_migrations WHERE id='20260920_010_tasks_and_constrained_automations' AND checksum='7dbfd762818b605bb29338093a5c77e1bbbab03ab318e2dddf1cca6fbd994b73'")" '1'
check_eq 'all nine task/automation indexes exist' "$(psql_at "SELECT count(*) FROM pg_indexes WHERE schemaname=current_schema() AND indexname = ANY (ARRAY['voxera_docs_task_queue','voxera_docs_task_resource','voxera_docs_automation_event_source','voxera_docs_automation_event_trigger','voxera_docs_automation_rule_version','voxera_docs_automation_rules_active','voxera_docs_automation_run_idempotency','voxera_docs_automation_runs_rule','voxera_docs_automation_notifications'])")" '9'
check_eq 'both immutable automation-evidence triggers exist' "$(psql_at "SELECT count(*) FROM pg_trigger WHERE tgrelid='voxera_docs'::regclass AND NOT tgisinternal AND tgname = ANY (ARRAY['voxera_immutable_automation_evidence_update','voxera_immutable_automation_evidence_delete'])")" '2'
check_eq 'automation evidence trigger function exists once' "$(psql_at "SELECT count(*) FROM pg_proc WHERE proname='voxera_reject_immutable_automation_evidence_change'")" '1'

check_true 'disposable store contains automation events' "$(( $(psql_at "SELECT count(*) FROM voxera_docs WHERE collection='automationEvents'") > 0 ? 1 : 0 ))" 'synthetic event evidence exists'
check_true 'disposable store contains immutable rule versions' "$(( $(psql_at "SELECT count(*) FROM voxera_docs WHERE collection='automationRuleVersions'") > 0 ? 1 : 0 ))" 'synthetic rule-version evidence exists'
check_true 'disposable store contains task and run rows' "$(( $(psql_at "SELECT count(*) FROM voxera_docs WHERE collection IN ('tasks','automationRuns')") > 1 ? 1 : 0 ))" 'task/run evidence exists'

logs="$(mktemp -d)"
trap 'rm -rf "$logs"' EXIT
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -c "UPDATE voxera_docs SET body=body WHERE seq=(SELECT seq FROM voxera_docs WHERE collection='automationEvents' ORDER BY seq LIMIT 1)" >"$logs/update" 2>&1; then
  printf 'FAIL  direct automation-event update unexpectedly succeeded\n' >&2; exit 1
fi
check_true 'direct automation-event update is rejected' "$(grep -qi 'append-only automation evidence' "$logs/update" && echo 1 || echo 0)" 'database trigger rejection observed'
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -c "DELETE FROM voxera_docs WHERE seq=(SELECT seq FROM voxera_docs WHERE collection='automationRuleVersions' ORDER BY seq LIMIT 1)" >"$logs/delete" 2>&1; then
  printf 'FAIL  direct rule-version delete unexpectedly succeeded\n' >&2; exit 1
fi
check_true 'direct rule-version delete is rejected' "$(grep -qi 'append-only automation evidence' "$logs/delete" && echo 1 || echo 0)" 'database trigger rejection observed'

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -c "INSERT INTO voxera_docs(collection,id,body) SELECT collection, 'duplicate_event_source_probe', jsonb_set(body,'{id}','\"duplicate_event_source_probe\"'::jsonb) FROM voxera_docs WHERE collection='automationEvents' ORDER BY seq LIMIT 1" >"$logs/event-unique" 2>&1; then
  printf 'FAIL  duplicate automation event source unexpectedly inserted\n' >&2; exit 1
fi
check_true 'event source uniqueness is database-enforced' "$(grep -qi 'voxera_docs_automation_event_source' "$logs/event-unique" && echo 1 || echo 0)" 'unique event-source index rejection observed'
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -c "INSERT INTO voxera_docs(collection,id,body) SELECT collection, 'duplicate_rule_version_probe', jsonb_set(body,'{id}','\"duplicate_rule_version_probe\"'::jsonb) FROM voxera_docs WHERE collection='automationRuleVersions' ORDER BY seq LIMIT 1" >"$logs/version-unique" 2>&1; then
  printf 'FAIL  duplicate automation rule version unexpectedly inserted\n' >&2; exit 1
fi
check_true 'rule-version uniqueness is database-enforced' "$(grep -qi 'voxera_docs_automation_rule_version' "$logs/version-unique" && echo 1 || echo 0)" 'unique rule/version index rejection observed'
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -c "INSERT INTO voxera_docs(collection,id,body) SELECT collection, 'duplicate_run_probe', jsonb_set(body,'{id}','\"duplicate_run_probe\"'::jsonb) FROM voxera_docs WHERE collection='automationRuns' ORDER BY seq LIMIT 1" >"$logs/run-unique" 2>&1; then
  printf 'FAIL  duplicate automation run idempotency key unexpectedly inserted\n' >&2; exit 1
fi
check_true 'run idempotency is database-enforced' "$(grep -qi 'voxera_docs_automation_run_idempotency' "$logs/run-unique" && echo 1 || echo 0)" 'unique run-idempotency index rejection observed'

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q <<'SQL' >"$logs/maintenance" 2>&1
BEGIN;
SET LOCAL voxera.allow_immutable_maintenance = 'on';
UPDATE voxera_docs SET body=body WHERE seq=(SELECT seq FROM voxera_docs WHERE collection='automationEvents' ORDER BY seq LIMIT 1);
ROLLBACK;
SQL
check_true 'explicit transaction-local maintenance bypass remains available' '1' 'update succeeded only inside rolled-back maintenance window'

printf '\ntasks-automations-postgres-check: %d assertions passed\n' "$pass"
