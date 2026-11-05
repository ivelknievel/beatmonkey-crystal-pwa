import { openDB } from 'idb';

const AUTH_ENDPOINT = '/api/auth';
const STORAGE_KEY = 'bm_auth_token';
// Memory keeps a session usable when storage is disabled; never assume storage works.
const memory = new Map<string, string | null>();
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
      expiresIn: Math.max(0, claims.exp - Date.now() / 1000),
      subsonic_user: data.subsonic_user || data.user_name || data.user?.user_name || '',
      subsonic_pass: data.subsonic_pass || '',
    };
  } catch { return null; }
}

function getAuthDB() {
  return openDB('beatmonkey-auth', 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    },
  });
}
async function writeValue(key: string, value: string | null): Promise<void> {
  memory.set(key, value);
  try {
    const db = await getAuthDB();
    if (value === null) await db.delete('meta', key);
    else await db.put('meta', { key, value });
  } catch { /* retain in-memory session */ }
}
async function readValue(key: string): Promise<string | null> {
  if (memory.has(key)) return memory.get(key) ?? null;
  try {
    const db = await getAuthDB();
    const entry = await db.get('meta', key);
    return typeof entry?.value === 'string' ? entry.value : null;
  } catch {
    // A failed read is not evidence of absence: callers must not revoke/erase it.
    throw new Error('Sessieopslag is tijdelijk niet beschikbaar');
  }
}
export async function saveToken(token: string): Promise<void> {
  await writeValue(STORAGE_KEY, token);
  localWrite('bm_auth_revoked', null);
}
export async function loadToken(): Promise<string | null> {
  if (localRead('bm_auth_revoked')) return null;
  return readValue(STORAGE_KEY);
}
export async function deleteToken(): Promise<void> {
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
export async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await loadToken();
  const headers = new Headers(options.headers);
  if (token && isTokenValid(token)) headers.set('Authorization', 'Bearer ' + token);
  return fetch(url, { ...options, headers });
}
