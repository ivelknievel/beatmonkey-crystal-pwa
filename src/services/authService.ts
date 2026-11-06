import { openDB } from 'idb';

const AUTH_ENDPOINT = '/api/auth';
const STORAGE_KEY = 'bm_auth_token';

// In-flight refresh single-flight tracking and generation counter
let refreshFlight: Promise<string> | null = null;
let refreshAbortController: AbortController | null = null;
let sessionGeneration = 0;

export function getSessionGeneration(): number {
  return sessionGeneration;
}

// Memory keeps a session usable when storage is disabled; never assume storage works.
const memory = new Map<string, string | null>();
let persistenceQueue: Promise<void> = Promise.resolve();
function localRead(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function localWrite(key: string, value: string | null): void {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* disabled/quota */ }
}

export function decodeJwt(token: string): any {
  try {
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
  } catch { return null; }
}

export async function exchangeGoogleToken(credential: string, expectedNonce?: string): Promise<{
  user: { id: string; name: string; email: string; avatar: string };
  accessToken: string;
  expiresIn: number;
  subsonic_user?: string;
  subsonic_pass?: string;
} | null> {
  try {
    const res = await fetch(AUTH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: credential, client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID, ...(expectedNonce ? { expected_nonce: expectedNonce } : {}) }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.token || !isTokenValid(data.token)) return null;
    const claims = decodeJwt(data.token);
    // Exchange is intentionally side-effect free; the store owns session acceptance.
    return {
      user: {
        id: data.user?.id || data.user_id || claims.sub || '',
        name: data.user?.name || data.user?.user_name || data.user_name || claims.name || claims.user_name || 'Gebruiker',
        email: data.user?.email || claims.email || data.user_name || '',
        avatar: data.user?.avatar || data.picture || claims.picture || '',
      },
      accessToken: data.token,
      expiresIn: Math.max(0, Math.floor(claims.exp - Date.now() / 1000)),
      subsonic_user: data.subsonic_user || data.user_name || '',
      subsonic_pass: data.subsonic_pass || '',
    };
  } catch { return null; }
}

function getAuthDB() {
  return openDB('beatmonkey-auth', 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    },
  });
}

async function writeValue(key: string, value: string | null): Promise<void> {
  memory.set(key, value);
  const write = persistenceQueue.catch(() => {}).then(async () => { try {
    const db = await getAuthDB();
    if (value === null) await db.delete('meta', key);
    else await db.put('meta', { key, value });
  } catch {
    // IndexedDB failure must not lose the in-memory write.
  } });
  persistenceQueue = write;
  await write;
}

async function readValue(key: string): Promise<string | null> {
  if (memory.has(key)) return memory.get(key)!;
  const db = await getAuthDB();
  const entry = await db.get('meta', key);
  return entry?.value || null;
}

export async function saveToken(token: string): Promise<void> {
  // Explicit accepted login, never called by the refresh path.
  sessionGeneration++;
  localWrite('bm_auth_revoked', null);
  await writeValue(STORAGE_KEY, token);
}

export async function loadToken(): Promise<string | null> {
  if (localRead('bm_auth_revoked')) return null;
  return readValue(STORAGE_KEY);
}

export async function deleteToken(): Promise<void> {
  sessionGeneration++;
  // Invalidate any inflight refresh session
  if (refreshAbortController) {
    refreshAbortController.abort();
    refreshAbortController = null;
  }
  // Persistent tombstone prevents failed IndexedDB deletion resurrecting a session.
  localWrite('bm_auth_revoked', '1');
  await writeValue(STORAGE_KEY, null);
}

export async function saveSubsonicCredentials(user: string, pass: string): Promise<void> {
  await writeValue('subsonic_user', user);
  await writeValue('subsonic_pass', pass);
  // Remove duplicated legacy secrets; IndexedDB remains the primary persistence.
  localWrite('bm_user', null); localWrite('bm_pass', null);
  localWrite('bm_auth_revoked', null);
}

export async function loadSubsonicCredentials(): Promise<{ user: string; pass: string } | null> {
  if (localRead('bm_auth_revoked')) return null;
  const user = await readValue('subsonic_user');
  if (user) return { user, pass: await readValue('subsonic_pass') || '' };
  if (memory.has('subsonic_user')) return null;
  const legacyUser = localRead('bm_user');
  return legacyUser ? { user: legacyUser, pass: localRead('bm_pass') || '' } : null;
}

export async function clearSubsonicCredentials(): Promise<void> {
  localWrite('bm_auth_revoked', '1');
  localWrite('bm_user', null); localWrite('bm_pass', null);
  await writeValue('subsonic_user', null);
  await writeValue('subsonic_pass', null);
}

export function isTokenValid(token: string): boolean {
  const payload = decodeJwt(token);
  return typeof payload?.exp === 'number' && Number.isFinite(payload.exp) && payload.exp * 1000 > Date.now();
}

/**
 * Explicitly establishes a refresh cookie session for the given access token.
 */
export async function createRefreshSession(token: string): Promise<boolean> {
  const prior = refreshFlight;
  refreshAbortController?.abort();
  if (prior) await prior.catch(() => {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-BM-Client': 'web',
        'X-BM-CSRF': '1',
      },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Revokes the server-side refresh session cookie and invalidates inflight refresh requests.
 */
export async function revokeCoreSession(): Promise<void> {
  const prior = refreshFlight;
  sessionGeneration++;
  if (refreshAbortController) {
    refreshAbortController.abort();
    refreshAbortController = null;
  }
  const controller = new AbortController();
  if (prior) await prior.catch(() => {});
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-BM-Client': 'web',
        'X-BM-CSRF': '1',
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
  } catch {
    // Network errors during logout shouldn't prevent local teardown
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refreshes the core access token via httpOnly session cookie.
 * Bounded single-flight, same-origin, checks expected userId/sub identity to prevent cross-account switches.
 */
export async function refreshCoreSession(expectedUserId?: string): Promise<string> {
  if (refreshFlight) {
    const token = await refreshFlight;
    if (expectedUserId && decodeJwt(token)?.sub !== expectedUserId) throw new Error('Identiteit gewijzigd');
    return token;
  }
  if (localRead('bm_auth_revoked')) throw new Error('Sessie verlopen. Log opnieuw in.');

  const generationAtStart = sessionGeneration;
  const controller = new AbortController();
  refreshAbortController = controller;
  const timer = setTimeout(() => controller.abort(), 10000);

  let flight: Promise<string> = Promise.resolve('');
  flight = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-BM-Client': 'web',
          'X-BM-CSRF': '1',
        },
        body: JSON.stringify({}),
        signal: controller.signal,
      });

      if (generationAtStart !== sessionGeneration || controller.signal.aborted) {
        throw new Error('Sessie vernieuwen geannuleerd/uitgelogd');
      }

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.detail || 'Sessie verlopen. Log opnieuw in.');
      }

      const data = await res.json();
      if (generationAtStart !== sessionGeneration || controller.signal.aborted) {
        throw new Error('Sessie vernieuwen geannuleerd/uitgelogd');
      }

      const newToken = data.token || data.access_token;
      if (!newToken || typeof newToken !== 'string' || !isTokenValid(newToken)) {
        throw new Error('Ongeldig sessietoken ontvangen');
      }

      const claims = decodeJwt(newToken);
      if (!claims || !claims.sub) {
        throw new Error('Verplicht claim sub ontbreekt in sessietoken');
      }

      let expectedSub = expectedUserId;
      if (!expectedSub) {
        const prior = await loadToken();
        expectedSub = prior ? decodeJwt(prior)?.sub : undefined;
        if (!expectedSub) {
          const creds = await loadSubsonicCredentials();
          if (!creds?.user || claims.user_name !== creds.user) throw new Error('Identiteit gewijzigd');
        }
      }

      if (expectedSub && String(claims.sub) !== String(expectedSub)) {
        throw new Error('Identiteit gewijzigd (identity switch gedetecteerd)');
      }

      if (generationAtStart !== sessionGeneration || controller.signal.aborted) {
        throw new Error('Sessie vernieuwen geannuleerd/uitgelogd');
      }

      // Rotation updates the same identity; it must not invalidate its own generation.
      await writeValue(STORAGE_KEY, newToken);
      if (generationAtStart !== sessionGeneration || controller.signal.aborted) {
        throw new Error('Sessie vernieuwen geannuleerd/uitgelogd');
      }

      return newToken;
    } catch (err: any) {
      if (controller.signal.aborted || err?.name === 'AbortError') {
        throw new Error('Sessie vernieuwen geannuleerd/uitgelogd');
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (refreshFlight === flight) {
        refreshFlight = null;
        if (refreshAbortController === controller) {
          refreshAbortController = null;
        }
      }
    }
  })();

  refreshFlight = flight;
  return flight;
}

/**
 * Ensures a valid core access token exists. If expired or missing, attempts refresh or re-auth.
 */
export async function ensureCoreSession(expectedUserId?: string): Promise<string | null> {
  const token = await loadToken();
  if (token && isTokenValid(token)) {
    if (expectedUserId) {
      const claims = decodeJwt(token);
      const id = claims?.sub || claims?.user_id;
      if (id && String(id) !== String(expectedUserId)) {
        throw new Error('Identiteit gewijzigd (identity switch gedetecteerd)');
      }
    }
    return token;
  }

  // Derive expected identity from expired saved token claims if arg omitted
  let targetExpectedId = expectedUserId;
  let isSavedGoogleToken = false;
  if (token) {
    const expiredClaims = decodeJwt(token);
    if (expiredClaims) {
      isSavedGoogleToken = true;
      if (!targetExpectedId && expiredClaims.sub) {
        targetExpectedId = String(expiredClaims.sub);
      }
    }
  }

  // Token is missing or expired, attempt cookie refresh
  try {
    const refreshed = await refreshCoreSession(targetExpectedId);
    return refreshed;
  } catch (refreshErr: any) {
    // If refresh fails due to identity mismatch or explicit revocation, re-throw
    if (/identiteit|identity switch/i.test(refreshErr?.message)) {
      throw refreshErr;
    }

    // Never fallback to password for stored Google token (needs refresh or genuine login)
    if (isSavedGoogleToken) {
      return null;
    }

    // Manual saved creds with no token may do real password auth after binding
    const creds = await loadSubsonicCredentials();
    if (creds?.user && creds?.pass) {
      try {
        const sessionResult = await getCorePasswordSession(creds.user, creds.pass);
        if (sessionResult?.token) {
          if (targetExpectedId) {
            const claims = decodeJwt(sessionResult.token);
            const id = claims?.sub || claims?.user_id;
            if (id && String(id) !== String(targetExpectedId)) {
              throw new Error('Identiteit gewijzigd (identity switch gedetecteerd)');
            }
          }
          return sessionResult.token;
        }
      } catch {
        // Fall through
      }
    }
    return null;
  }
}

/**
 * Side-effect free network exchange only: obtains a core access token using username and password.
 * Store generation owns saveToken / createRefreshSession after revision check in persist.
 */
export async function getCorePasswordSession(username: string, pass: string): Promise<{ token: string; user: any } | null> {
  const res = await fetch('/api/auth/password', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-BM-Client': 'web',
      'X-BM-CSRF': '1',
    },
    body: JSON.stringify({ username, password: pass }),
  });

  if (!res.ok) {
    return null;
  }

  const data = await res.json();
  const token = data.token || data.access_token;
  if (!token) return null;

  const claims = decodeJwt(token);
  const tokenUser = claims?.user_name || claims?.sub;
  if (tokenUser && tokenUser.toLowerCase() !== username.toLowerCase()) {
    throw new Error('Identiteit komt niet overeen met inloggegevens');
  }

  return {
    token,
    user: data.user || {
      id: claims?.sub || data.id,
      name: claims?.name || claims?.user_name || username,
      email: claims?.email || '',
      avatar: claims?.picture || '',
    },
  };
}

function isSameOriginTrustedPath(url: string): boolean {
  if (typeof url !== 'string') return false;
  // Relative paths are always same-origin
  if (url.startsWith('/') && !url.startsWith('//') && !url.includes('\\')) return true;
  if (typeof window !== 'undefined' && window?.location?.origin) {
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.origin === window.location.origin;
    } catch {
      return false;
    }
  }
  return false;
}

export async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const isTrustedApi = isSameOriginTrustedPath(url);
  const headers = new Headers(options.headers);

  let token = await loadToken();
  if (token && isTokenValid(token)) {
    if (isTrustedApi) {
      headers.set('Authorization', 'Bearer ' + token);
    }
  }

  let response: Response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (err) {
    throw err;
  }

  // Bounded single 401 refresh retry for trusted API paths
  if (response.status === 401 && isTrustedApi) {
    const method = (options.method || 'GET').toUpperCase();
    const isIdempotentPost = method === 'POST' && (url === '/api/youtube/jobs' || url.startsWith('/api/youtube/jobs?'));
    const isSafeMethod = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

    if (isSafeMethod || isIdempotentPost) {
      try {
        const expectedId = token ? (decodeJwt(token)?.sub || decodeJwt(token)?.user_id) : undefined;
        const newToken = await refreshCoreSession(expectedId);
        if (newToken) {
          const retryHeaders = new Headers(options.headers);
          retryHeaders.set('Authorization', 'Bearer ' + newToken);
          return await fetch(url, { ...options, headers: retryHeaders });
        }
      } catch {
        return response;
      }
    }
  }

  return response;
}
