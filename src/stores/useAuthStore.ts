import { create } from 'zustand';
import {
  exchangeGoogleToken, saveToken, loadToken, deleteToken, isTokenValid, decodeJwt,
  loadSubsonicCredentials, saveSubsonicCredentials, clearSubsonicCredentials,
  ensureCoreSession, createRefreshSession, revokeCoreSession, getCorePasswordSession,
} from '../services/authService';
import { setCredentials, getServerUrl, validateCredentials } from '../services/subsonic';
import { usePlayerStore } from './playerStore';
import { AudioEngine } from '../engine/AudioEngine';

interface User { id: string; name: string; email: string; avatar: string }
interface AuthState {
  user: User | null;
  token: string | null;
  subsonic_user: string | null;
  subsonic_pass: string | null;
  accountScope: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (credential: string, expectedNonce?: string) => Promise<boolean>;
  loginManual: (user: string, pass: string) => Promise<boolean>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  setUser: (user: User | null) => void;
}

let revision = 0;
let authenticatingRevision: number | null = null;
let checking: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();
function persist(action: () => Promise<void>): Promise<void> {
  writes = writes.catch(() => {}).then(action);
  return writes;
}
const signedOut = { user: null, token: null, subsonic_user: null, subsonic_pass: null, accountScope: null, isAuthenticated: false, isLoading: false, error: null };

export const useAuthStore = create<AuthState>((set, get) => {
  function revoke() {
    // Invalidate player generations before credentials change (no cross-account saves).
    usePlayerStore.getState().setAccountScope(null);
    setCredentials('', '');
    set(signedOut);
  }

  function establish(user: string, pass: string, token: string | null, profile: User | null) {
    const scope = JSON.stringify([getServerUrl().replace(/\/+$/, ''), user]);
    const changed = get().accountScope !== scope;
    if (changed) usePlayerStore.getState().setAccountScope(scope);
    setCredentials(user, pass);
    set({ user: profile, token, subsonic_user: user, subsonic_pass: pass, accountScope: scope, isAuthenticated: true, isLoading: false, error: null });
    if (changed) {
      AudioEngine.init();
      const player = usePlayerStore.getState();
      void player.syncLikedSets().catch(() => {});
      // A protected shared route owns selection/position; don't race its timestamp.
      if (typeof window === 'undefined' || !/\/set\//.test(window.location.pathname)) {
        void player.restoreLastPosition().catch(() => {});
      }
    }
  }

  async function clearSaved() { await deleteToken(); await clearSubsonicCredentials(); }

  return {
    ...signedOut, isLoading: true,
    checkSession: () => {
      if (authenticatingRevision !== null) return Promise.resolve();
      if (checking) return checking;
      const current = ++revision;
      const task = (async () => {
        try {
          await writes;
          if (current !== revision) return;

          const activeToken = get().token;
          let token = await loadToken();
          if (current !== revision) return;

          // If active token was present but storage returned null, treat as revoked
          if (activeToken !== null && token === null) {
            revoke();
            await persist(clearSaved);
            return;
          }

          // Call ensureCoreSession only when expired or missing manual else load once
          if (!token || !isTokenValid(token)) {
            const currentUserId = get().user?.id;
            try {
              const ensured = await ensureCoreSession(currentUserId);
              if (ensured) {
                token = ensured;
              }
            } catch (err: any) {
              if (/identiteit|identity switch/i.test(err?.message)) {
                revoke();
                await persist(clearSaved);
                return;
              }
            }
          }

          if (current !== revision) return;

          // An expired Google identity with no refresh cookie or reauth must never degrade into an invalid state
          if (token && !isTokenValid(token)) {
            revoke(); await persist(clearSaved); return;
          }

          const creds = await loadSubsonicCredentials();
          if (current !== revision) return;
          if (!creds?.user) {
            // Absence is not proof that stored credentials were rejected: a cold
            // start (or a storage read that raced document teardown) must not
            // write a permanent revocation tombstone over a valid session.
            set(signedOut);
            return;
          }
          if (!await validateCredentials(creds.user, creds.pass)) {
            if (current === revision) { revoke(); await persist(clearSaved); }
            return;
          }
          if (current !== revision) return;
          // Time can pass while validating a restored credential.
          if (token && !isTokenValid(token)) { revoke(); await persist(clearSaved); return; }
          const claims = token ? decodeJwt(token) : null;
          establish(creds.user, creds.pass, token, claims ? {
            id: claims.sub || claims.user_id || '', name: claims.name || claims.user_name || creds.user,
            email: claims.email || '', avatar: claims.picture || '',
          } : null);
        } catch {
          if (current !== revision) return;
          if (get().token && !isTokenValid(get().token!)) {
            revoke(); await persist(clearSaved); return;
          }
          // Offline, server and storage failures cannot prove identity rejection.
          // Keep active playback/credentials; cold starts stay signed out for retry.
          set({ isLoading: false, error: 'Kan sessie niet controleren. Controleer de verbinding en probeer opnieuw.' });
        }
      })();
      checking = task;
      void task.finally(() => { if (checking === task) checking = null; });
      return task;
    },
    login: async (credential, expectedNonce) => {
      const current = ++revision;
      authenticatingRevision = current;
      set({ isLoading: true, error: null });
      try {
        const result = await exchangeGoogleToken(credential, expectedNonce);
        if (current !== revision) return false;
        if (!result?.accessToken || !isTokenValid(result.accessToken) || !result.subsonic_user) {
          set({ isLoading: false, error: 'Google authenticatie mislukt' }); return false;
        }
        await persist(async () => {
          if (current !== revision) return;
          await saveToken(result.accessToken);
          await saveSubsonicCredentials(result.subsonic_user!, result.subsonic_pass || '');
          // Explicitly establish refresh cookie session via createRefreshSession
          await createRefreshSession(result.accessToken);
        });
        if (current !== revision) return false;
        if (!isTokenValid(result.accessToken)) { await get().logout(); return false; }
        establish(result.subsonic_user, result.subsonic_pass || '', result.accessToken, result.user);
        return true;
      } catch {
        if (current === revision) set({ isLoading: false, error: 'Authenticatie error' });
        return false;
      } finally {
        if (authenticatingRevision === current) authenticatingRevision = null;
      }
    },
    loginManual: async (user, pass) => {
      const current = ++revision;
      authenticatingRevision = current;
      // LoginFlow owns submit progress; don't unmount it (or lose typed values).
      set({ error: null });
      try {
        if (!user || !await validateCredentials(user, pass)) {
          if (current === revision) set({ isLoading: false, error: 'Verkeerde gebruikersnaam of wachtwoord' });
          return false;
        }
        if (current !== revision) return false;

        // Obtain core token and session via getCorePasswordSession (side-effect free network exchange)
        let coreToken: string | null = null;
        let coreUser: User | null = null;
        try {
          const coreResult = await getCorePasswordSession(user, pass);
          if (coreResult) {
            coreToken = coreResult.token;
            coreUser = coreResult.user;
          }
        } catch {
          // If core password session fails, keep coreToken null and proceed with subsonic auth
        }

        if (current !== revision) return false;
        await persist(async () => {
          if (current !== revision) return;
          if (coreToken) {
            await saveToken(coreToken);
            await createRefreshSession(coreToken);
          } else {
            await deleteToken();
          }
          await saveSubsonicCredentials(user, pass);
        });
        if (current !== revision) return false;
        establish(user, pass, coreToken, coreUser);
        return true;
      } catch {
        if (current === revision) set({ isLoading: false, error: 'Kan geen verbinding maken' });
        return false;
      } finally {
        if (authenticatingRevision === current) authenticatingRevision = null;
      }
    },
    logout: async () => {
      ++revision;
      authenticatingRevision = null;
      revoke();
      try { sessionStorage.removeItem('bm_google_request'); sessionStorage.removeItem('auth_return_url'); } catch { /* unavailable storage */ }

      // Local delete immediately tombstone; old cookie clearing network ordered same auth mutex
      await persist(async () => {
        await clearSaved();
        try { await revokeCoreSession(); } catch { /* ignore */ }
      });
    },
    setUser: user => set({ user }),
  };
});
