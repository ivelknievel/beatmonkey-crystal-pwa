# Beatmonkey Crystal iOS audit remediation plan

Goal: repair the two-model audit findings while retaining user work, two independent recovery paths, test evidence, and rollback.

## Protected starting point

- Source: /opt/beatmonkey-pwa; existing work committed as 1973453cf0772d76f98a223ccc12ddad26de6190.
- Restricted verified backups: /opt/backups/beatmonkey-pwa/20261105T162930Z/ (source+.git+.env, active static release, backend auth originals, audit evidence).
- Private off-server Git: ivelknievel/beatmonkey-crystal-pwa-recovery, branch fix/ios-pwa-audit-20261105. API read-back SHA equals local snapshot.
- Existing origin is public. Use the private recovery remote for audit/remediation work; do not publish unpatched security findings or credentials in the public repository.
- AGY quota exhausted explicitly (429; reset about 14 hours). No retries on that quota; use available GPT implementation agents.

## Architecture and shared contracts

Keep React/TypeScript/Zustand/Vite. No framework rewrite, no silent-audio workaround, no speculative WebAudio disconnect. Player selection and resume are generation-bound; explicit album and song identities; one cue lookup. Audio defaults to normal HTMLAudioElement, visualization optional and must not dictate audio lifecycle.

Player owner must expose:
- store action setAccountScope(scope: string | null): reset player/async generations on account change, use account-namespaced favourites, remove legacy shared favourites from active state; this action must not save old positions under new credentials.
- store action resetPlayer(): stop/reset media without losing the store's permanent engine subscription.
- engine reset(): clear current media/metadata safely without removing permanent state subscribers.

Auth owner will call setAccountScope with stable server+username identity when credentials are established and null before/at logout. Do not edit player-owned files. Coordinate imports/contracts; escalate missing interface rather than modifying another owner's file.

## Ordered tasks and ownership

1. Snapshot original backend source and audit in private Git; add recovery tag. No production deployment.
2. PLAYER owner: AudioEngine.ts, playerStore.ts, types/index.ts, new cue helper and player tests. Write regression assertions expecting correct behaviour and capture RED first. Fix SOL01-05, SOL07, SOL12-14; empty favourites handling (SOL06) belongs here too. Include stale selection/resume/tracklist responses, finite/clamped seeks, duplicate saves, rejected playback recovery, real audio-source restore without autoplay, listener-preserving reset. Do not touch auth/UI/build config.
3. AUTH/API owner: authService.ts, subsonic.ts, useAuthStore.ts, RootLayout.tsx, LoginFlow.tsx, GoogleLoginButton.tsx, UserProfile.tsx, SettingsPage.tsx and tests. TDD logout/account expiry, one session gate, application-success validator, Unicode UTF-8 MD5, localStorage denial handling, Headers merging. Preserve supported Google redirect mechanism; secure random state+nonce stored and verified, use expected nonce on server if API supports it. No native app regressions. No player store edits.
4. WEB owner: service-worker.js, manifest/index HTML, shared route, FullscreenPlayerOverlay/TracklistSection/Scrubber/TrackRow, remaining UI CSS, safe precache build generator + SW/browser tests. TDD ownership-only cache cleanup after successful install, hashed bundles, network/auth/stream bypass, explicit update prompt (no automatic reload mid-audio); shared HTTPS URLs preserve song/album/time and query-only navigation, 16px inputs, safe-area ancestors, accessible slider/dialog/focus and gesture cancellation. Do not change audio pipeline or global auth logic.
5. BACKEND owner: tracked backend/beatmonkey-core source copies + focused Python tests only (not running production). Add server-side audience allowlist before verification, retain intended existing Android+web clients, verify provided nonce when supplied by browser and reject mismatch. Existing signature+issuer+email whitelist stay intact. No environment/config/db changes. Parent will decide deployment after independent review.
6. Parent integration: source review and cross-module checks; explicit TypeScript project typecheck, unit suite; ensure .env remains local/ignored with sanitized .env.example; deterministic build; local preview/browser regression Chromium+WebKit if installable within resources. Do not claim physical iPhone or OAuth success without actual evidence.
7. Check fix traceability against every audit item. Independent review finds regressions then bounded fix cycles. Commit and push BEFORE release build; remote SHA read-back. Build resulting commit, hash release. Prefer verified staging/preview over untested production changes. Only switch live static release after safe browser verification and recorded rollback. Backend deployment is separate and must not bypass server-specific tests.

## Validation rules

- Tests are in repo, assert desired correct behaviour, demonstrate baseline RED and final GREEN. The earlier scratch audit asserts bugs and must not be called a passing product suite.
- Fixtures explicit: never present fake API data as live production evidence.
- Resource check before browser installs/builds; run one build/browser worker at a time. Keep heavy unrelated infrastructure untouched.
- Do not reset/clean existing work, force-push, drop previous chunks while old clients may still need them, commit .env/keys/raw backup archives, print credentials or auth URLs.
- No new dependency versions guessed. Use existing installed packages/Node native test capabilities where possible; research primary docs if changing framework/plugin API.

## Rollback and delivery

Restricted archives + immutable Git tag are the pre-change recovery routes. Final report includes hashes, Git branch/commit links, tests actually run, live-vs-preview status, unresolved hardware-only validation and explicit audit status per finding.
