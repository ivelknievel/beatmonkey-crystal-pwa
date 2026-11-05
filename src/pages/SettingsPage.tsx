import { Settings, User, LogOut, Server } from 'lucide-react';
import { getServerUrl, getCredentials } from '../services/subsonic';
import { useAuthStore } from '../stores/useAuthStore';
import { UserProfile } from '../components/Auth/UserProfile';

export function SettingsPage() {
  const server = getServerUrl();
  const { user } = getCredentials();

  const handleLogout = useAuthStore((s) => s.logout);

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <header className="flex items-center gap-3 border-b border-[var(--color-crystal-border)] pb-4">
        <div className="p-2 rounded-xl bg-[var(--color-crystal-surface)] border border-[var(--color-crystal-border)] text-gray-300">
          <Settings className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Instellingen</h1>
          <p className="text-sm text-gray-400">Serververbinding, audiokwaliteit en account</p>
        </div>
      </header>

      {/* Account / Server Status */}
      <div className="rounded-2xl border border-[var(--color-crystal-border)] bg-[var(--color-crystal-card)]/50 p-6 space-y-4">
        <h2 className="text-base font-semibold text-white flex items-center gap-2">
          <User className="w-5 h-5 text-[var(--color-crystal-cyan)]" />
          Subsonic Account
        </h2>

        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--color-crystal-surface)]">
            <span className="text-gray-400 flex items-center gap-2">
              <Server size={16} /> Server
            </span>
            <span className="font-mono text-white text-xs truncate max-w-[240px]">{server}</span>
          </div>

          <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--color-crystal-surface)]">
            <span className="text-gray-400 flex items-center gap-2">
              <User size={16} /> Gebruiker
            </span>
            <span className="font-medium text-white">{user || 'Niet ingelogd'}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={handleLogout}
          className="w-full py-3 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 font-semibold rounded-xl text-sm transition-colors flex items-center justify-center gap-2 cursor-pointer mt-4"
        >
          <LogOut size={16} />
          Uitloggen
        </button>
      </div>

      {/* Google Account Profile */}
      <UserProfile />

      {/* Versie */}
      <div className="text-center py-6">
        <p className="text-xs text-gray-500">Versie 20</p>
        <p className="text-xs text-gray-600 mt-1">© 2026</p>
      </div>
    </div>
  );
}

export default SettingsPage;
