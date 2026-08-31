import { openDB } from 'idb';
import { setCredentials } from './subsonic';

const AUTH_ENDPOINT = '/api/auth';
const STORAGE_KEY = 'bm_auth_token';

export function decodeJwt(token: string): any {
  try {
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
    return JSON.parse(atob(padded));
  } catch { return null; }
}

export async function exchangeGoogleToken(credential: string): Promise<{
  user: any;
  accessToken: string;
  expiresIn: number;
  subsonic_user?: string;
  subsonic_pass?: string;
} | null> {
  try {
    const res = await fetch(AUTH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        id_token: credential,
        client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.token) return null;

    if (data.token) {
      await saveToken(data.token);
    }

    const subsonicUser = data.subsonic_user || data.user_name || '';
    const subsonicPass = data.subsonic_pass || '';

    if (subsonicUser) {
      await saveSubsonicCredentials(subsonicUser, subsonicPass);
      try {
        localStorage.setItem('bm_user', subsonicUser);
        localStorage.setItem('bm_pass', subsonicPass);
      } catch {
        /* ignore localStorage quota/disabled errors */
      }
      setCredentials(subsonicUser, subsonicPass);
    }

    return {
      user: {
        id: data.user?.id || data.user_id || '',
        name: data.user?.name || data.user_name || 'Gebruiker',
        email: data.user?.email || data.user_name || '',
        avatar: data.user?.avatar || data.picture || '',
      },
      accessToken: data.token,
      expiresIn: 3600,
      subsonic_user: subsonicUser,
      subsonic_pass: subsonicPass,
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

export async function saveToken(token: string): Promise<void> {
  const db = await getAuthDB();
  await db.put('meta', { key: STORAGE_KEY, value: token });
}

export async function loadToken(): Promise<string | null> {
  const db = await getAuthDB();
  const entry = await db.get('meta', STORAGE_KEY);
  return entry?.value || null;
}

export async function deleteToken(): Promise<void> {
  const db = await getAuthDB();
  await db.delete('meta', STORAGE_KEY);
}

export async function saveSubsonicCredentials(user: string, pass: string): Promise<void> {
  const db = await getAuthDB();
  await db.put('meta', { key: 'subsonic_user', value: user });
  await db.put('meta', { key: 'subsonic_pass', value: pass });
}

export async function loadSubsonicCredentials(): Promise<{ user: string; pass: string } | null> {
  try {
    const db = await getAuthDB();
    const userEntry = await db.get('meta', 'subsonic_user');
    const passEntry = await db.get('meta', 'subsonic_pass');
    if (userEntry?.value) {
      return { user: userEntry.value, pass: passEntry?.value || '' };
    }
  } catch {
    /* fallback to localStorage if indexedDB fails */
  }
  const legacyUser = typeof localStorage !== 'undefined' ? localStorage.getItem('bm_user') : null;
  const legacyPass = typeof localStorage !== 'undefined' ? localStorage.getItem('bm_pass') : null;
  if (legacyUser) {
    return { user: legacyUser, pass: legacyPass || '' };
  }
  return null;
}

export async function clearSubsonicCredentials(): Promise<void> {
  const db = await getAuthDB();
  await db.delete('meta', 'subsonic_user');
  await db.delete('meta', 'subsonic_pass');
}

export function isTokenValid(token: string): boolean {
  const payload = decodeJwt(token);
  if (!payload || !payload.exp) return false;
  return payload.exp * 1000 > Date.now();
}

export async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await loadToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (token && isTokenValid(token)) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  return fetch(url, { ...options, headers });
}
