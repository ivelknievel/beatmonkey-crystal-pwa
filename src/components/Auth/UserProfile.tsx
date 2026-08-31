import { LogOut, User } from 'lucide-react';
import { useAuthStore } from '../../stores/useAuthStore';

export function UserProfile() {
  const { user, isAuthenticated, logout } = useAuthStore();

  if (!isAuthenticated || !user) return null;

  return (
    <div className="rounded-2xl border border-[var(--color-crystal-border)] bg-[var(--color-crystal-card)]/50 p-6 space-y-4">
      <h2 className="text-base font-semibold text-white flex items-center gap-2">
        <User size={20} className="text-[var(--color-crystal-cyan)]" />
        Google Account
      </h2>

      <div className="flex items-center gap-3 p-3 rounded-xl bg-[var(--color-crystal-surface)]">
        <img
          src={user.avatar}
          alt={user.name}
          className="w-10 h-10 rounded-full border-2 border-[var(--color-crystal-cyan)]"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white truncate">{user.name}</p>
          <p className="text-xs text-gray-400 truncate">{user.email}</p>
        </div>
      </div>

      <button
        type="button"
        onClick={logout}
        className="w-full py-3 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 font-semibold rounded-xl text-sm transition-colors flex items-center justify-center gap-2 cursor-pointer"
      >
        <LogOut size={16} />
        Google Uitloggen
      </button>
    </div>
  );
}
