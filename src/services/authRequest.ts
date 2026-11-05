// Browser request binding for the existing Google hybrid redirect flow.
// Signature, issuer, audience and expected_nonce are verified by /api/auth.
const KEY = 'bm_google_request';
const MAX_AGE = 10 * 60 * 1000;

export function safeReturnUrl(value: string): string {
  try {
    const path = value.replace(/^\/app(?=\/|$)/, '') || '/discover';
    const decoded = decodeURIComponent(path);
    if (!path.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\') || Array.from(decoded).some(char => char.charCodeAt(0) <= 32)) return '/discover';
    const url = new URL(path, 'https://return.invalid');
    if (url.origin !== 'https://return.invalid' || url.pathname.includes('/auth/callback')) return '/discover';
    return url.pathname + url.search + url.hash;
  } catch { return '/discover'; }
}

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
}

export function beginGoogleRequest(returnUrl: string) {
  const context = { state: randomToken(), nonce: randomToken(), returnUrl: safeReturnUrl(returnUrl), createdAt: Date.now() };
  // Do not redirect if this browser cannot retain the request binding.
  sessionStorage.removeItem('auth_return_url');
  sessionStorage.setItem(KEY, JSON.stringify(context));
  return context;
}

export function clearGoogleRequest(): void {
  try { sessionStorage.removeItem(KEY); sessionStorage.removeItem('auth_return_url'); } catch { /* unavailable storage */ }
}

export function consumeGoogleCallback(fragment: string): { idToken: string; expectedNonce: string; returnUrl: string } {
  let raw: string | null = null;
  try { raw = sessionStorage.getItem(KEY); } finally { clearGoogleRequest(); }
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const context = raw ? JSON.parse(raw) : null;
  if (!context || !/^[a-f0-9]{64}$/.test(context.state) || !/^[a-f0-9]{64}$/.test(context.nonce) || params.get('state') !== context.state || !Number.isFinite(context.createdAt) || Date.now() - context.createdAt > MAX_AGE || context.createdAt > Date.now()) {
    throw new Error('Ongeldige of verlopen Google-aanvraag. Probeer opnieuw.');
  }
  const idToken = params.get('id_token');
  if (params.has('error') || !idToken) throw new Error('Geen geldig token ontvangen van Google');
  try {
    const payload = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')));
    if (claims.nonce !== context.nonce) throw new Error('nonce mismatch');
  } catch { throw new Error('Google-aanvraag komt niet overeen met dit antwoord'); }
  return { idToken, expectedNonce: context.nonce, returnUrl: safeReturnUrl(context.returnUrl) };
}
