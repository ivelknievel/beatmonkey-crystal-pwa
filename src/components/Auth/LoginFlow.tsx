import { useState } from 'react';
import { Music, Loader2, AlertCircle } from 'lucide-react';
import { GoogleLoginButton } from './GoogleLoginButton';
import { useAuthStore } from '../../stores/useAuthStore';

export function LoginFlow() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loginManual = useAuthStore((s) => s.loginManual);
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (!await loginManual(username, password)) {
        setError(useAuthStore.getState().error || 'Inloggen mislukt');
      }
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 bg-[#0a0a0f] flex items-center justify-center p-4 z-50">
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-crystal-cyan to-crystal-pink flex items-center justify-center mx-auto mb-4 shadow-lg">
            <Music size={32} className="text-black" />
          </div>
          <h1 className="text-2xl font-bold text-white">Beatmonkey Crystal</h1>
          <p className="text-sm text-gray-400 mt-1">Log in om te streamen</p>
        </div>

        {/* Login form */}
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label htmlFor="username" className="text-xs text-gray-400 mb-1.5 block">Gebruikersnaam</label>
            <input
              id="username"
              name="username"
              type="text"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-[#12121f] border border-[#2a2a3e] rounded-xl px-4 py-3 text-white text-base focus:outline-none focus:border-crystal-cyan transition-colors"
              placeholder="Gebruikersnaam"
              autoComplete="username"
            />
          </div>

          <div>
            <label htmlFor="password" className="text-xs text-gray-400 mb-1.5 block">Wachtwoord</label>
            <input
              id="password"
              name="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-[#12121f] border border-[#2a2a3e] rounded-xl px-4 py-3 text-white text-base focus:outline-none focus:border-crystal-cyan transition-colors"
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3.5 bg-gradient-to-r from-crystal-cyan to-crystal-pink text-black font-bold rounded-xl text-sm hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
          >
            {loading ? <Loader2 size={18} className="animate-spin" /> : null}
            {loading ? 'Bezig met verbinden...' : 'Inloggen'}
          </button>

          <GoogleLoginButton />

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-400 bg-red-400/10 rounded-xl px-4 py-3">
              <AlertCircle size={16} />
              {error}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

export default LoginFlow;
