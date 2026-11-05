import { Search, X } from 'lucide-react';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SearchBar({
  value,
  onChange,
  placeholder = "Zoek DJ's, festivals of sets...",
}: SearchBarProps) {
  return (
    <div className="relative w-full">
      <Search
        size={16}
        className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none"
      />
      <input
        type="search"
        aria-label="Zoek DJ's, festivals of sets"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-[var(--color-crystal-surface,#12121a)] border border-[var(--color-crystal-border,#222230)] rounded-xl py-2.5 pl-9 pr-9 text-base text-white placeholder-gray-500 focus:outline-none focus:border-[var(--color-crystal-cyan,#00e5ff)] transition-colors"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white transition-colors cursor-pointer"
          aria-label="Zoekopdracht wissen"
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
}

export default SearchBar;
