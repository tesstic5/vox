#!/usr/bin/env python3
"""Local HTTP regression for tenant, role, module and public field-service APIs."""
import json
import os
import secrets
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = os.environ.get('VOXERA_BASE', 'http://127.0.0.1:3015').rstrip('/')
if urllib.parse.urlparse(BASE).hostname not in ('127.0.0.1', 'localhost', '::1'):
    sys.exit('field-api-check only runs against localhost')
STAMP = secrets.token_hex(4)
PASSWORD = 'field-probe-password-2026'
PREFIX = f'Field API Check {STAMP}'
passes = 0
failures = []


def call(method, path, body=None, cookie=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header('x-forwarded-for', f'198.51.100.{20 + len(path) % 150}')
    if data is not None:
        req.add_header('content-type', 'application/json')
    if cookie:
        req.add_header('cookie', cookie)
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            raw = res.read()
            return res.status, json.loads(raw or b'{}'), res.headers
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            payload = json.loads(raw or b'{}')
        except json.JSONDecodeError:
            payload = {'raw': raw.decode('utf-8', 'replace')[:300]}
        return err.code, payload, err.headers


def check(label, condition, detail=''):
    global passes
    print(('PASS  ' if condition else 'FAIL  ') + label + (f' — {detail}' if detail else ''))
    if condition:
        passes += 1
    else:
        failures.append(label)


def signup(tag):
    email = f'field-{tag}-{STAMP}@example.test'
    status, payload, headers = call('POST', '/api/auth/signup', {
        'email': email,
        'password': PASSWORD,
        'name': f'{tag.title()} Owner',
        'orgName': f'{PREFIX} {tag}',
        'businessType': 'contractor',
    })
    cookie = (headers.get('set-cookie') or '').split(';')[0]
    check(f'{tag} contractor signup', status == 201 and cookie.startswith('voxera_session='), f'HTTP {status}')
    if not cookie:
        raise RuntimeError(payload)
    return email, cookie, (payload.get('org') or {}).get('id')


def invite(owner_cookie, role, tag):
    email = f'field-{role}-{tag}-{STAMP}@example.test'
    status, payload, _ = call('POST', '/api/v1/team', {
        'action': 'invite', 'name': f'{role.title()} Probe', 'email': email, 'role': role,
    }, owner_cookie)
    temp = payload.get('temporaryPassword')
    member = payload.get('member') or {}
    check(f'owner invites {role}', status == 201 and bool(temp) and bool(member.get('id')), f'HTTP {status}')
    status, login, headers = call('POST', '/api/auth/login', {'email': email, 'password': temp})
    cookie = (headers.get('set-cookie') or '').split(';')[0]
    check(f'{role} signs in', status == 200 and cookie.startswith('voxera_session='), f'HTTP {status}')
    return cookie, member


def main():
    email_a, a, org_a = signup('a')
    _, b, org_b = signup('b')
    check('workspace IDs are distinct', bool(org_a and org_b and org_a != org_b))

    status, boot, _ = call('POST', '/api/bootstrap', {}, a)
    check('production-mode bootstrap succeeds', status in (200, 201), f'HTTP {status}')
    check('production bootstrap creates no demo assistants', boot.get('assistants') == 0, json.dumps({k: boot.get(k) for k in ('assistants', 'numbers', 'calls')}, default=str))
    check('production bootstrap creates no placeholder numbers', boot.get('numbers') == 0)
    check('production bootstrap creates no invented practice roster', (boot.get('practice') or {}).get('seeded') is False and (boot.get('practice') or {}).get('reason') == 'setup_required', json.dumps(boot.get('practice')))
    for label, path in [('assistants', '/api/v1/assistants'), ('numbers', '/api/v1/numbers'), ('providers', '/api/v1/providers'), ('locations', '/api/v1/locations')]:
        status, payload, _ = call('GET', path, cookie=a)
        check(f'fresh production {label} list is honestly empty', status == 200 and payload.get('data') == [], f'HTTP {status}, rows={len(payload.get("data") or [])}')

    status, onboarding, _ = call('GET', '/api/v1/onboarding', cookie=a)
    use_cases = [row.get('id') for row in onboarding.get('useCases') or []]
    check('contractor setup recommends field enquiry assistant', status == 200 and use_cases[0] == 'contractor-enquiries', str(use_cases))
    check('contractor setup shows empty operations as incomplete', onboarding.get('operations', {}).get('ready') is False)

    status, profile, _ = call('GET', '/api/v1/workspace/profile', cookie=a)
    check('workspace profile persists explicit contractor type', status == 200 and profile.get('business', {}).get('type') == 'contractor')

    enquiry_payload = {
        'customer': {'name': 'Taylor API', 'number': '+15555551212', 'email': 'taylor-api@example.test'},
        'description': 'Replace the failed circulation pump',
        'urgency': 'urgent',
        'siteAddress': {'line1': '12 API Street', 'city': 'Test City', 'region': 'TC', 'postalCode': '12012', 'country': 'US'},
    }
    status, enquiry, _ = call('POST', '/api/v1/enquiries', enquiry_payload, a)
    enquiry_id = enquiry.get('id')
    check('owner creates tenant-scoped enquiry', status == 201 and enquiry.get('reference', '').startswith('ENQ-'), f'HTTP {status}')
    status, _, _ = call('GET', f'/api/v1/enquiries/{enquiry_id}', cookie=b)
    check('another workspace cannot read enquiry by ID', status == 404, f'HTTP {status}')

    status, estimate, _ = call('POST', '/api/v1/estimates', {
        'enquiryId': enquiry_id,
        'description': enquiry_payload['description'],
        'lines': [
            {'description': 'Replacement pump', 'quantity': 1, 'unitAmountMinor': 25000, 'taxRatePct': 10},
            {'description': 'Installation labour', 'quantity': 2, 'unitAmountMinor': 8000, 'taxRatePct': 10},
        ],
        'currency': 'USD',
        'validUntil': (datetime.now(timezone.utc) + timedelta(days=14)).date().isoformat(),
        'notes': 'Subject to safe access.',
    }, a)
    estimate_id = estimate.get('id')
    check('owner creates versioned estimate', status == 201 and estimate.get('version') == 1 and estimate.get('totalMinor') == 45100, f'HTTP {status}, total={estimate.get("totalMinor")}')
    status, _, _ = call('GET', f'/api/v1/estimates/{estimate_id}', cookie=b)
    check('another workspace cannot read estimate by ID', status == 404, f'HTTP {status}')

    subprocess.run(
        ['npx', 'tsx', 'scripts/probe-verify-user.ts', email_a], cwd=os.path.dirname(os.path.dirname(__file__)),
        env={**os.environ, 'VOXERA_PROBE_VERIFY': '1'}, check=True, capture_output=True, text=True,
    )
    status, shared, _ = call('POST', f'/api/v1/estimates/{estimate_id}', {'action': 'share'}, a)
    accept_url = shared.get('acceptUrl', '')
    check('verified owner creates a secure link without fake delivery', status == 200 and '/estimate/' in accept_url and shared.get('delivery', {}).get('status') == 'not_sent', f'HTTP {status}')
    token = urllib.parse.urlparse(accept_url).path.rsplit('/', 1)[-1]
    status, public, _ = call('GET', f'/api/public/estimates/{token}')
    check('public link exposes the exact estimate version', status == 200 and public.get('estimate', {}).get('reference') == estimate.get('reference') and public.get('estimate', {}).get('version') == 1, f'HTTP {status}')
    status, decision, _ = call('POST', f'/api/public/estimates/{token}', {'decision': 'accepted', 'name': 'Taylor API', 'email': 'taylor-api@example.test'})
    check('customer accepts once through public API', status == 200 and decision.get('decision') == 'accepted', f'HTTP {status}')
    status, _, _ = call('POST', f'/api/public/estimates/{token}', {'decision': 'accepted', 'name': 'Taylor API'})
    check('public acceptance token is single-use', status == 409, f'HTTP {status}')

    status, job, _ = call('POST', f'/api/v1/estimates/{estimate_id}', {'action': 'convert'}, a)
    job_id = job.get('id')
    check('accepted estimate converts to one job', status == 201 and job.get('estimateId') == estimate_id, f'HTTP {status}')
    status, _, _ = call('POST', f'/api/v1/estimates/{estimate_id}', {'action': 'convert'}, a)
    check('duplicate estimate conversion is refused', status == 409, f'HTTP {status}')

    status, location, _ = call('POST', '/api/v1/locations', {'name': 'API Dispatch', 'timezone': 'UTC'}, a)
    location_id = location.get('id')
    check('owner creates dispatch location', status == 201 and bool(location_id), f'HTTP {status}')
    status, service, _ = call('POST', '/api/v1/services', {'name': f'API Field Visit {STAMP}', 'durationMinutes': 60, 'active': True}, a)
    service_id = service.get('id')
    check('owner creates real field service', status == 201 and bool(service_id), f'HTTP {status}')
    status, provider, _ = call('POST', '/api/v1/providers', {
        'name': 'API Technician', 'title': 'Technician', 'locationIds': [location_id], 'serviceIds': [service_id], 'active': True,
    }, a)
    provider_id = provider.get('id')
    check('owner creates technician', status == 201 and bool(provider_id), f'HTTP {status}')
    status, rota, _ = call('PUT', '/api/v1/rota', {
        'providerId': provider_id, 'locationId': location_id,
        'windows': [{'weekday': day, 'start': '08:00', 'end': '18:00'} for day in range(7)],
        'breaks': [{'start': '12:00', 'end': '12:30', 'label': 'Lunch'}],
    }, a)
    check('owner saves technician rota', status == 200 and len(rota.get('windows') or []) == 7, f'HTTP {status}')

    status, visit, _ = call('POST', '/api/v1/visits', {'jobId': job_id, 'durationMinutes': 60, 'travelBufferMinutes': 15, 'instructions': 'Call on arrival'}, a)
    visit_id = visit.get('id')
    check('job receives an unassigned visit', status == 201 and visit.get('status') == 'unassigned', f'HTTP {status}')
    day = datetime.now(timezone.utc) + timedelta(days=4)
    starts_at = day.replace(hour=10, minute=0, second=0, microsecond=0).isoformat().replace('+00:00', 'Z')
    status, scheduled, _ = call('POST', f'/api/v1/visits/{visit_id}', {
        'action': 'schedule', 'startsAt': starts_at, 'providerId': provider_id, 'locationId': location_id, 'serviceId': service_id,
        'durationMinutes': 60, 'travelBufferMinutes': 15,
    }, a)
    check('visit schedules through live collision engine', status == 200 and scheduled.get('status') == 'scheduled' and bool(scheduled.get('bookingId')), f'HTTP {status}')

    status, conflict_visit, _ = call('POST', '/api/v1/visits', {'jobId': job_id, 'durationMinutes': 60}, a)
    conflict_visit_id = conflict_visit.get('id')
    status, conflict, _ = call('POST', f'/api/v1/visits/{conflict_visit_id}', {
        'action': 'schedule', 'startsAt': starts_at, 'providerId': provider_id, 'locationId': location_id, 'serviceId': service_id,
    }, a)
    check('overlapping technician visit is refused', status == 409, f'HTTP {status}, {conflict.get("error", {}).get("message", "")}')

    practitioner, practitioner_member = invite(a, 'practitioner', 'a')
    status, linked, _ = call('POST', '/api/v1/day', {'action': 'provider:link', 'providerId': provider_id}, practitioner)
    check('technician links only their login to technician record', status == 200 and linked.get('linked', {}).get('id') == provider_id, f'HTTP {status}')
    status, assigned_jobs, _ = call('GET', '/api/v1/jobs', cookie=practitioner)
    check('technician job list contains assigned job only', status == 200 and [row.get('id') for row in assigned_jobs.get('data') or []] == [job_id] and assigned_jobs.get('summary') is None, f'HTTP {status}, rows={len(assigned_jobs.get("data") or [])}')
    status, _, _ = call('POST', '/api/v1/enquiries', enquiry_payload, practitioner)
    check('technician cannot create coordinator enquiry', status == 403, f'HTTP {status}')

    other_payload = dict(enquiry_payload)
    other_payload['customer'] = {'name': 'Other Customer', 'number': '+15555551313'}
    other_payload['description'] = 'Direct unassigned work'
    status, other_job, _ = call('POST', '/api/v1/jobs', {**other_payload, 'lines': []}, a)
    other_job_id = other_job.get('id')
    check('owner creates a separate unassigned direct job', status == 201 and bool(other_job_id), f'HTTP {status}')
    status, _, _ = call('GET', f'/api/v1/jobs/{other_job_id}', cookie=practitioner)
    check('technician cannot read an unassigned job by ID', status == 403, f'HTTP {status}')
    status, other_visit, _ = call('POST', '/api/v1/visits', {'jobId': other_job_id, 'durationMinutes': 30}, a)
    status, _, _ = call('GET', f'/api/v1/visits/{other_visit.get("id")}', cookie=practitioner)
    check('technician cannot read an unassigned visit by ID', status == 403, f'HTTP {status}')

    for field_status in ('en_route', 'on_site', 'completed'):
        status, changed, _ = call('POST', f'/api/v1/visits/{visit_id}', {'action': 'status', 'status': field_status}, practitioner)
        check(f'technician moves own visit to {field_status}', status == 200 and changed.get('status') == field_status, f'HTTP {status}')
    status, _, _ = call('POST', f'/api/v1/visits/{conflict_visit_id}', {'action': 'status', 'status': 'cancelled', 'note': 'Collision probe only'}, a)
    check('coordinator cancels unused conflict probe visit', status == 200)
    status, completed_job, _ = call('POST', f'/api/v1/jobs/{job_id}', {'action': 'status', 'status': 'completed'}, a)
    check('job completes only after every visit is terminal', status == 200 and completed_job.get('status') == 'completed', f'HTTP {status}')
    status, invoice, _ = call('POST', f'/api/v1/jobs/{job_id}', {'action': 'invoice'}, a)
    check('completed job hands exact lines to draft invoice', status == 201 and invoice.get('invoice', {}).get('totalMinor') == estimate.get('totalMinor'), f'HTTP {status}')
    status, _, _ = call('POST', f'/api/v1/jobs/{job_id}', {'action': 'reopen'}, a)
    check('invoiced completed job cannot be reopened silently', status == 409, f'HTTP {status}')

    viewer, _ = invite(a, 'viewer', 'a')
    status, _, _ = call('POST', '/api/v1/jobs', {**other_payload, 'lines': []}, viewer)
    check('viewer cannot create a field job', status == 403, f'HTTP {status}')

    status, b_enquiry, _ = call('POST', '/api/v1/enquiries', {**enquiry_payload, 'customer': {'name': 'B Customer', 'number': '+15555551414'}}, b)
    check('second workspace creates its own historical enquiry', status == 201, f'HTTP {status}')
    modules_without_field = ['customers', 'schedule', 'communications', 'money', 'reports', 'assistants']
    status, changed_profile, _ = call('PATCH', '/api/v1/workspace/profile', {'modules': modules_without_field}, b)
    check('owner can disable field-service navigation module', status == 200 and 'field_service' not in changed_profile.get('business', {}).get('modules', []), f'HTTP {status}')
    status, _, _ = call('POST', '/api/v1/enquiries', {**enquiry_payload, 'customer': {'name': 'Blocked New', 'number': '+15555551515'}}, b)
    check('disabled module blocks creation of new field work', status == 403, f'HTTP {status}')
    status, historical, _ = call('GET', f'/api/v1/enquiries/{b_enquiry.get("id")}', cookie=b)
    check('disabled module does not delete or hide historical work', status == 200 and historical.get('id') == b_enquiry.get('id'), f'HTTP {status}')
    status, historical, _ = call('POST', f'/api/v1/enquiries/{b_enquiry.get("id")}', {'action': 'status', 'status': 'qualified'}, b)
    check('disabled module still permits explicit handling of existing work', status == 200 and historical.get('status') == 'qualified', f'HTTP {status}')

    status, _, _ = call('GET', '/api/v1/enquiries')
    check('field-service API requires authentication', status == 401, f'HTTP {status}')

    print(f'field-api-check: {passes} checks passed; {len(failures)} failed')
    if failures:
        print('FAILED: ' + ', '.join(failures))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
