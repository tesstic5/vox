#!/usr/bin/env python3
"""Verify the dashboard's remaining generic collection contract.

Only two global collection reads remain: authoritative tools are hydrated
read-only for assistant editors, while workspace notices use the row lane so
read/clear actions persist. Retired demo slices and unwired preference switches
must not return to every dashboard navigation.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _session import cached_cookie  # noqa: E402

BASE = os.environ.get('VOXERA_BASE', 'http://127.0.0.1:3000')
EMAIL = os.environ.get('VOXERA_EMAIL', 'jordan@northwind.dev')
PASSWORD = os.environ.get('VOXERA_PASSWORD', 'demo-password-2026')
CLIENT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib', 'server-sync.tsx')
passed = 0
failed: list[str] = []


def check(label: str, condition: bool, detail: str = '') -> None:
    global passed
    if condition:
        passed += 1
        print(f'PASS  {label}' + (f'  — {detail}' if detail else ''))
    else:
        failed.append(label)
        print(f'FAIL  {label}' + (f'  — {detail}' if detail else ''))


cookie = cached_cookie(BASE, EMAIL, PASSWORD)


def call(method: str, path: str, body=None, auth: bool = True):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header('content-type', 'application/json')
    if auth and cookie:
        req.add_header('cookie', cookie)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=30) as res:
            return res.status, json.loads(res.read().decode() or '{}')
    except urllib.error.HTTPError as err:
        try:
            return err.code, json.loads(err.read().decode() or '{}')
        except json.JSONDecodeError:
            return err.code, {}
    except OSError as err:
        return 0, {'message': str(err)}


def list_from_source(name: str) -> list[str]:
    src = open(CLIENT, encoding='utf8').read()
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    src = re.sub(r'//[^\n]*', '', src)
    start = src.index(f'export const {name} = [')
    end = src.index(']', start)
    return re.findall(r"'([^']+)'", src[start:end])


hydrate = list_from_source('HYDRATE_COLLECTION_KEYS')
mirror = list_from_source('MIRROR_KEYS')
settings = list_from_source('SETTINGS_KEYS')
check('server-owned resources hydrate through native APIs, not the generic bridge', hydrate == [], ', '.join(hydrate) or 'none')
check('only persisted workspace notices use the generic row mirror', mirror == ['notifications'], ', '.join(mirror))
check('no unwired singleton preference is mirrored', settings == [], ', '.join(settings) or 'none')

for name in [*hydrate, *mirror, *settings]:
    status, body = call('GET', f'/api/v1/collections/{name}')
    check(f'the server accepts `{name}`', status == 200, f"{status} · {len(body.get('data') or [])} row(s)")

status, _ = call('GET', '/api/v1/collections/tools', auth=False)
check('collection hydration requires authentication', status == 401, f'HTTP {status}')
status, body = call('GET', '/api/v1/collections/definitelyNotACollection')
check('an unknown collection is refused', status == 404, f"{status} {str(body.get('error'))[:40]}")

before = len(call('GET', '/api/v1/collections/notifications')[1].get('data') or [])
status, body = call('POST', '/api/v1/collections/notifications', {'docs': [], 'mode': 'append'})
after = len(call('GET', '/api/v1/collections/notifications')[1].get('data') or [])
check('the notice row lane accepts the client write shape', status == 200 and body.get('written') == 0, f'{status} {json.dumps(body)[:80]}')
check('an empty append deletes nothing', before == after, f'{before} before, {after} after')

source = open(CLIENT, encoding='utf8').read()
check('read-only hydration is excluded from the mirror writer', 'for (const name of SYNCED_KEYS)' in source and 'HYDRATE_COLLECTION_KEYS, ...SYNCED_KEYS' in source)
owned = {'providerSettings', 'onboarding', 'widget', 'billing', 'security'}
check('no server-owned slice is generically mirrored', not (set(mirror) | set(settings)) & owned)
retired = {'simulations', 'logs', 'members', 'campaigns', 'squads', 'workflows', 'mcpServers', 'batches', 'rubrics', 'evals', 'alerts', 'roles', 'invites', 'files', 'activity', 'notificationPrefs'}
active = set(hydrate) | set(mirror) | set(settings)
check('retired demo slices add no global dashboard requests', not active & retired, ', '.join(sorted(active & retired)) or 'none')

print()
print(f"{'ALL PASS' if not failed else str(len(failed)) + ' FAILED'} — {passed} check(s); {len(hydrate)} read-only and {len(mirror)} mirrored collection(s).")
if failed:
    for label in failed:
        print(f'  · {label}')
sys.exit(1 if failed else 0)
