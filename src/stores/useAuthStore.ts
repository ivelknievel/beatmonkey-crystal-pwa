import { create } from 'zustand';
import {
  exchangeGoogleToken,
  saveToken,
  loadToken,
  deleteToken,
  isTokenValid,
  decodeJwt,
  loadSubsonicCredentials,
  clearSubsonicCredentials,
} from '../services/authService';
import { setCredentials } from '../services/subsonic';
import { usePlayerStore } from './playerStore';

interface User {
  id: string;
  name: string;
  email: string;
  avatar: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  subsonic_user: string | null;
  subsonic_pass: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (credential: string) => Promise<boolean>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  setUser: (user: User | null) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: null,
  subsonic_user: null,
  subsonic_pass: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,

  checkSession: async () => {
    set({ isLoading: true });
    try {
      const token = await loadToken();
      if (token && isTokenValid(token)) {
        const payload = decodeJwt(token);
        if (payload) {
          const creds = await loadSubsonicCredentials();
          if (creds && creds.user) {
            setCredentials(creds.user, creds.pass);
            try {
              usePlayerStore.getState().syncLikedSets();
            } catch {
              /* ignore */
            }
          }
          set({
            user: { id: payload.sub, name: payload.name, email: payload.email, avatar: payload.picture },
            token,
            subsonic_user: creds?.user || null,
            subsonic_pass: creds?.pass || null,
            isAuthenticated: true,
            isLoading: false,
          });
          return;
        }
      }
      set({ isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  login: async (credential: string) => {
    set({ isLoading: true, error: null });
    try {
      const result = await exchangeGoogleToken(credential);
      if (!result || !result.accessToken) {
        set({ isLoading: false, error: 'Google authenticatie mislukt' });
        return false;
      }
      await saveToken(result.accessToken);
      if (result.subsonic_user) {
        setCredentials(result.subsonic_user, result.subsonic_pass || '');
        try {
          usePlayerStore.getState().syncLikedSets();
        } catch {
          /* ignore */
        }
      }
      set({
        user: result.user,
        token: result.accessToken,
        subsonic_user: result.subsonic_user || null,
        subsonic_pass: result.subsonic_pass || null,
        isAuthenticated: true,
        isLoading: false,
      });
      return true;
    } catch (err) {
      set({ isLoading: false, error: 'Authenticatie error' });
      return false;
    }
  },

  logout: async () => {
    await deleteToken();
    await clearSubsonicCredentials();
    try {
      localStorage.removeItem('bm_user');
      localStorage.removeItem('bm_pass');
    } catch {
      /* ignore */
    }
    setCredentials('', '');
    set({ user: null, token: null, subsonic_user: null, subsonic_pass: null, isAuthenticated: false, error: null });
  },

  setUser: (user) => set({ user }),
}));
