# Backend auth boundary — audit 10.4A

All application edits are in this private tracked mirror. Production `/opt/beatmonkey-core` was read only. No installs, commits, pushes, restarts, config edits or DB changes.

## Behaviour

- Reject a supplied `client_id` unless already in the server-owned allowlist, before Google verification/network request construction.
- Keep the four existing web/Android client identifiers and configured `GOOGLE_CLIENT_ID` trust expansion unchanged.
- Verify through Google's signed-token verifier exactly once. Require a scalar allowlisted `aud` on every success path; if a client was requested, the verified audience must equal it. No audience-relaxed retry after verification failure.
- When `client_id` is omitted, Google's verifier still checks signature/expiry/issuer, and the server requires its returned audience in the existing allowlist. This preserves Android without a requested client even if server configuration selects a web client.
- Require a Google issuer, independently of the verifier result.
- `AuthLoginRequest.expected_nonce: Optional[str] = None` is forwarded unchanged by login. When supplied, it must be nonempty and exactly match the verified nonce claim. Omission remains compatible with Android; a missing token nonce is acceptable only when no expected nonce was supplied.
- Login still requires a token email and a Navidrome email-whitelist match before issuing a session. Existing TEST_MODE behaviour is unchanged; production must not enable TEST_MODE.
- Verification exceptions emit a fixed message, never exception details that could contain a raw token.

## Actual test scope and TDD evidence

`tests/test_auth_boundary.py` executes the actual AST function bodies of `verify_google_token` and `/api/auth` login, with decorators removed, plus actual server allowlist declarations. It loads the actual Pydantic `app/models.py`. Google verifier and request construction, whitelist and session issuance are explicit mocks. No Google network, real credentials, app startup, database or real crypto signature validation occurs. This is focused boundary coverage, not full FastAPI integration or an end-to-end OAuth test. Full mirror app imports are incomplete because non-auth modules are intentionally absent.

Initial RED: 16 tests, exit 1, 11 failures and 3 errors (missing nonce API/schema). This reproduced client-audience bypass, issuer checks, unsafe fallback, nonce omission and token-bearing exception logs. Existing positive/whitelist compatibility tests already passed. After implementation: 16 tests, exit 0. Two additional configuration/Android compatibility regression checks brought final suite to 18 tests, all passing under production's existing Python 3.12 venv.

Command (run from any directory):

```sh
env -u PYTHONPATH /opt/beatmonkey-core/venv/bin/python -m unittest discover -s /opt/beatmonkey-pwa/backend/beatmonkey-core/tests -p test_auth_boundary.py -v
```

The process-local `-u PYTHONPATH` avoids inherited Hermes Python 3.14 package paths polluting the Python 3.12 venv. It does not edit any config. Without it, an attempted venv test run failed to import the incompatible Pydantic extension (exit 1); the clean run passed (exit 0).

Additional checks: actual whole `auth.py` import through existing venv plus explicit Google/request mocks passed; AST parsing of auth/main/models/tests passed; `git diff --check -- backend/beatmonkey-core` passed. Repository-wide diff-check found another owner's `.gitignore` trailing blank line; this backend task did not edit it.

## Exact application deployment set (parent only, not deployed here)

Source under `/opt/beatmonkey-pwa/backend/beatmonkey-core/` to matching production application paths:

1. `app/auth.py` -> `/opt/beatmonkey-core/app/auth.py`
2. `app/main.py` -> `/opt/beatmonkey-core/app/main.py` (only the login verifier call changed)
3. `app/models.py` -> `/opt/beatmonkey-core/app/models.py`

`AuthLoginRequest` is in **models.py**, not schemas.py. This actual schema module was copied unchanged from production into the mirror before tests, then only the optional `expected_nonce` field was added. Deploy all three application files together: otherwise login may access a missing schema attribute or pass an unsupported verifier parameter. Do not deploy tests/docs as runtime dependencies.

Safe deployment prerequisites: parent must review final diffs, confirm fresh backup/recovery snapshots remain valid, confirm production files have not drifted since the mirrored baseline (merge only auth boundary changes if they have), and use the existing backend deployment mechanism/container rebuild if applicable. Preserve existing config/env/secrets/allowlist and DB; do not copy entire mirror over production. Backend rollout should precede frontend nonce transmission, since old backend/schema would silently ignore it. Existing frontend without nonce and existing Android remain accepted. Parent must perform post-rollout runtime verification and can roll back all three files together from the verified backup if necessary. No deployment/restart was executed in this task.
