#!/usr/bin/env python3
"""Isolated multi-workspace access regression.

Run ONLY against a fresh throwaway deployment and data directory. Creates accounts,
invites a viewer, writes sample records and tries security boundary violations.

  VOXERA_ISOLATED_SECURITY_TEST=1 VOXERA_BASE=http://127.0.0.1:3109 \
    python3 scripts/tenant-security-check.py

For the configured-allowlist variant, start the app with
VOXERA_OPERATOR_EMAILS='TENANT-OPERATOR@EXAMPLE.TEST' and set
VOXERA_EXPECT_OPERATOR=1 in the test environment. Run the empty-list variant
against a separate fresh instance. A Twilio/email stub on :4010 optionally tests
that a valid, narrowly scoped API key cannot reach the private collection bridge.
"""
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

if os.environ.get('VOXERA_ISOLATED_SECURITY_TEST') != '1':
    sys.exit('Refusing to run: set VOXERA_ISOLATED_SECURITY_TEST=1 for a throwaway deployment.')

BASE = os.environ.get('VOXERA_BASE', 'http://127.0.0.1:3109').rstrip('/')
if urllib.parse.urlparse(BASE).hostname not in ('localhost', '127.0.0.1', '::1'):
    sys.exit('Refusing to run: the isolated test target must be localhost.')
STUB = os.environ.get('TWILIO_STUB_BASE', 'http://127.0.0.1:4010').rstrip('/')
EXPECT_OPERATOR = os.environ.get('VOXERA_EXPECT_OPERATOR') == '1'
STAMP = secrets.token_hex(5)
PASSWORD = 'probe-password-2026'
failures = []
passes = 0


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(NoRedirect)


def call(method, path, body=None, cookie=None, token=None, base=BASE):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header('x-forwarded-for', '198.51.100.224')
    if data is not None:
        req.add_header('content-type', 'application/json')
    if cookie:
        req.add_header('cookie', cookie)
    if token:
        req.add_header('authorization', 'Bearer ' + token)
    try:
        with opener.open(req, timeout=120) as res:
            raw = res.read()
            try:
                payload = json.loads(raw or b'{}')
            except json.JSONDecodeError:
                payload = {'raw': raw.decode('utf-8', 'replace')[:150]}
            return res.status, payload, res.headers
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            payload = json.loads(raw or b'{}')
        except json.JSONDecodeError:
            payload = {'raw': raw.decode('utf-8', 'replace')[:150]}
        return err.code, payload, err.headers


def check(label, ok, detail=''):
    global passes
    print(('PASS  ' if ok else 'FAIL  ') + label + (f' — {detail}' if detail else ''))
    if ok:
        passes += 1
    else:
        failures.append(label)


def signup(email, org):
    status, body, headers = call('POST', '/api/auth/signup', {
        'email': email, 'password': PASSWORD, 'name': 'Tenant Test', 'orgName': org,
    })
    session = (headers.get('set-cookie') or '').split(';')[0]
    check(f'{org} signs up', status == 201 and session.startswith('voxera_session='), f'HTTP {status}')
    if status != 201 or not session:
        raise RuntimeError(f'Cannot continue without a fresh workspace: {body}')
    return session, (body.get('org') or {}).get('id')


def rows(cookie, name):
    status, body, _ = call('GET', '/api/v1/collections/' + name, cookie=cookie)
    return status, body.get('data') or []


def main():
    email_a = 'tenant-operator@example.test' if EXPECT_OPERATOR else f'tenant-a-{STAMP}@example.test'
    email_b = f'tenant-b-{STAMP}@example.test'
    a, org_a = signup(email_a, 'Tenant A')
    b, org_b = signup(email_b, 'Tenant B')
    check('the workspaces have distinct IDs', bool(org_a and org_b and org_a != org_b))

    for label, session, should_operate in [('A', a, EXPECT_OPERATOR), ('B', b, False)]:
        status, me, _ = call('GET', '/api/auth/me', cookie=session)
        actual = (me.get('user') or {}).get('platformOperator')
        check(f'{label}: operator flag matches explicit allowlist', status == 200 and actual is should_operate, f'flag={actual}')
        for name, path in [('admin', '/api/v1/admin/overview'), ('leads', '/api/v1/leads'), ('growth', '/api/v1/growth')]:
            status, _, _ = call('GET', path, cookie=session)
            expected = 200 if should_operate else 403
            check(f'{label}: {name} access follows allowlist', status == expected, f'HTTP {status}, expected {expected}')
        if not should_operate:
            status, _, _ = call('POST', '/api/v1/admin/orgs', {'action': 'suspend', 'orgId': org_b}, cookie=session)
            check(f'{label}: cannot suspend another workspace', status == 403, f'HTTP {status}')

    for provider in ('google', 'github'):
        for suffix in ('', '?code=fake-code&state=fake-state'):
            status, payload, headers = call('GET', f'/api/auth/oauth/{provider}{suffix}')
            cookies = headers.get_all('set-cookie') or []
            check(f'{provider}{" callback" if suffix else " start"} never issues a session',
                  status == 503 and (payload.get('error') or {}).get('code') == 'OAUTH_UNAVAILABLE'
                  and not any('voxera_session=' in c for c in cookies) and not headers.get('location'),
                  f'HTTP {status}, session={any("voxera_session=" in c for c in cookies)}')
    status, _, headers = call('GET', '/api/auth/oauth/unknown?code=x&state=y')
    check('unknown OAuth provider is 404 and issues no session', status == 404 and not headers.get('set-cookie'), f'HTTP {status}')
    status, me, _ = call('GET', '/api/auth/me')
    check('OAuth probes did not authenticate an anonymous request', status == 200 and me.get('authenticated') is False)

    # The retired raw by-ID route must not disclose the signed-in user's password hash.
    status, me_a, _ = call('GET', '/api/auth/me', cookie=a)
    user_a = (me_a.get('user') or {}).get('id')
    status, raw_user, _ = call('GET', f'/api/v1/collections/users/{user_a}', cookie=a)
    check('the raw by-ID bridge cannot expose a password hash', status == 404 and 'passwordHash' not in json.dumps(raw_user), f'HTTP {status}')

    # Creating a published assistant used to bypass verification. Creation must
    # remain a draft and the generic update route must not accept status changes.
    status, made_assistant, _ = call('POST', '/api/v1/assistants', {
        'name': 'Unverified publish probe', 'systemPrompt': 'Use only reviewed business information.', 'status': 'published',
    }, cookie=a)
    assistant_id = made_assistant.get('id')
    check('direct assistant creation cannot publish an unverified account', status == 201 and made_assistant.get('status') == 'draft', f'HTTP {status}, status={made_assistant.get("status")}')
    status, _, _ = call('PATCH', f'/api/v1/assistants/{assistant_id}', {'status': 'published'}, cookie=a)
    check('generic assistant editing cannot bypass the publish action', status == 400, f'HTTP {status}')

    # A real viewer login via the existing temporary-password invitation fallback.
    viewer_email = f'viewer-{STAMP}@example.test'
    status, invited, _ = call('POST', '/api/v1/team', {'action': 'invite', 'name': 'Viewer Test', 'email': viewer_email, 'role': 'viewer'}, cookie=a)
    temp = invited.get('temporaryPassword')
    check('owner can invite a viewer', status == 201 and bool(temp), f'HTTP {status}')
    if temp:
        status, login, headers = call('POST', '/api/auth/login', {'email': viewer_email, 'password': temp})
        viewer = (headers.get('set-cookie') or '').split(';')[0]
        role = (login.get('user') or {}).get('role')
        check('viewer signs in with their own read-only role', status == 200 and bool(viewer) and role == 'viewer', f'HTTP {status}, role={role}')
        if viewer:
            status, _, _ = call('POST', '/api/v1/assistants', {'name': 'Viewer write probe', 'systemPrompt': 'No'}, cookie=viewer)
            check('viewer cannot create an assistant', status == 403, f'HTTP {status}')
            status, _, _ = call('POST', '/api/v1/collections/notifications', {'docs': [{'id': 'viewer-write', 'message': 'no'}], 'mode': 'append'}, cookie=viewer)
            check('viewer cannot bulk-write dashboard collections', status == 403, f'HTTP {status}')
            status, _, _ = call('PATCH', '/api/v1/collections/notifications', {'id': 'viewer-write', 'patch': {'message': 'no'}}, cookie=viewer)
            check('viewer cannot patch dashboard collections', status == 403, f'HTTP {status}')

    # Singleton notification preferences were never wired to product behaviour and
    # have been retired rather than left as a writable pretend setting.
    for name, cookie in [('A', a), ('B', b)]:
        status, _, _ = call('GET', '/api/v1/collections/notificationPrefs', cookie=cookie)
        check(f'{name}: unwired notification preferences stay retired', status == 404, f'HTTP {status}')

    # Cross-tenant IDs must be rejected BEFORE any existing rows are removed.
    foreign_id = f'shared-{STAMP}'
    own_b_id = f'b-own-{STAMP}'
    status, _, _ = call('POST', '/api/v1/collections/notifications', {'docs': [{'id': foreign_id, 'message': 'Tenant A'}], 'mode': 'append'}, cookie=a)
    check('A can create its own mirror row', status == 200, f'HTTP {status}')
    status, _, _ = call('POST', '/api/v1/collections/notifications', {'docs': [{'id': own_b_id, 'message': 'Tenant B'}], 'mode': 'append'}, cookie=b)
    check('B can create its own mirror row', status == 200, f'HTTP {status}')
    status, _, _ = call('POST', '/api/v1/collections/notifications', {'docs': [{'id': foreign_id, 'message': 'attempted takeover'}], 'mode': 'replace'}, cookie=b)
    check('B cannot reuse a row ID belonging to A', status in (403, 409), f'HTTP {status}')
    _, data_a = rows(a, 'notifications')
    _, data_b = rows(b, 'notifications')
    check('A\'s original row survives collision attempt', any(d.get('id') == foreign_id and d.get('message') == 'Tenant A' for d in data_a))
    check('B\'s existing rows survive rejected bulk replace', any(d.get('id') == own_b_id for d in data_b))

    status, _, _ = call('PATCH', '/api/v1/collections/notifications', {'id': foreign_id, 'patch': {'orgId': org_b, 'message': 'moved'}}, cookie=a)
    _, data_a = rows(a, 'notifications')
    _, data_b = rows(b, 'notifications')
    check('patch cannot move a row into a different tenant', status in (400, 403) and any(d.get('id') == foreign_id for d in data_a) and not any(d.get('id') == foreign_id for d in data_b), f'HTTP {status}')
    status, _, _ = call('PATCH', '/api/v1/collections/notifications', {'id': foreign_id, 'patch': {'message': 'stolen'}}, cookie=b)
    check('B cannot patch A\'s row by ID', status == 404, f'HTTP {status}')

    marker = f'forged-{STAMP}'
    status, _, _ = call('POST', '/api/v1/collections/audit', {'docs': [{'id': marker, 'action': marker}], 'mode': 'append'}, cookie=a)
    _, audit_payload, _ = call('GET', '/api/v1/audit?limit=2000', cookie=a)
    audit_rows = audit_payload.get('data') or []
    check('the audit trail cannot be written through the collection bridge', status == 404 and not any(r.get('action') == marker for r in audit_rows), f'HTTP {status}')
    status, _, _ = call('POST', '/api/v1/collections/assistants', {'doc': {'id': f'asst-{STAMP}', 'status': 'published'}}, cookie=a)
    check('assistant publishing cannot bypass its API through the bridge', status == 404, f'HTTP {status}')
    for name in ('credentials', 'keys', 'security', 'providerSettings'):
        status, _, _ = call('GET', f'/api/v1/collections/{name}', cookie=a)
        check(f'raw {name} collection is not exposed by the bridge', status in (403, 404), f'HTTP {status}')

    # When the email stub is available, create an actual narrow-scope API key.
    try:
        call('POST', '/api/auth/verify', {}, cookie=a)
        _, state, _ = call('GET', '/__state', base=STUB)
        mails = [m for m in (state.get('sentEmails') or []) if m.get('to') == email_a]
        matches = [re.search(r'code is (\d{6})', m.get('text') or '') for m in mails]
        # The stub stores newest first; use this run's latest code rather than a
        # stale code for the fixed allowlisted operator address.
        code = next((m.group(1) for m in matches if m), None)
        if code:
            status, _, _ = call('POST', '/api/auth/verify/confirm', {'code': code}, cookie=a)
            status, created, _ = call('POST', '/api/v1/keys', {'name': 'Limited test key', 'scopes': ['calls:read']}, cookie=a)
            secret = created.get('secret')
            check('a verified owner creates a narrow API key', status == 201 and bool(secret), f'HTTP {status}')
            if secret:
                status, _, _ = call('GET', '/api/v1/collections/notifications', token=secret)
                check('API keys cannot bypass collection-bridge scope policy', status == 403, f'HTTP {status}')
        else:
            print('SKIP  API-key bridge check: verification email was not available from the stub')
    except OSError:
        print('SKIP  API-key bridge check: email stub is not running')

    print(f'\n{passes} passed; {len(failures)} failed')
    if failures:
        print('FAILURES: ' + ', '.join(failures))
        sys.exit(1)


if __name__ == '__main__':
    main()
