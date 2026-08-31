import type { ComponentType } from 'react';
import { useNavigate, useLocation } from '@tanstack/react-router';
import { LayoutGrid, Library, Heart, Settings } from 'lucide-react';

interface NavItem {
  label: string;
  icon: ComponentType<{ className?: string }>;
  path: string;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Ontdekken', icon: LayoutGrid, path: '/discover' },
  { label: 'Bibliotheek', icon: Library, path: '/library' },
  { label: 'Favorieten', icon: Heart, path: '/favorites' },
  { label: 'Instellingen', icon: Settings, path: '/settings' },
];

export function BottomNav() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav
      aria-label="Hoofdnavigatie"
      className="w-full bg-[var(--color-crystal-surface)] border-t border-[var(--color-crystal-border)] safe-bottom select-none z-30"
    >
      <div className="flex h-14 items-center justify-around px-2">
        {NAV_ITEMS.map(({ label, icon: Icon, path }) => {
          const isActive = location.pathname === path || location.pathname.startsWith(`${path}/`);
          return (
            <button
              key={path}
              type="button"
              onClick={() => navigate({ to: path })}
              className={`flex flex-1 flex-col items-center justify-center py-1 transition-colors ${
                isActive
                  ? 'text-[#00E5FF]'
                  : 'text-[#666666] hover:text-gray-300'
              }`}
            >
              <Icon className="h-5 w-5" />
              <span className="text-[10px] mt-1 font-medium tracking-tight">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export default BottomNav;
