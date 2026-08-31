import { Loader2 } from 'lucide-react';

export interface LoadingSpinnerProps {
  label?: string;
  size?: number;
}

export function LoadingSpinner({ label = 'Laden...', size = 28 }: LoadingSpinnerProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 space-y-3">
      <Loader2 size={size} className="animate-spin text-[var(--color-crystal-cyan,#00e5ff)]" />
      {label && <p className="text-xs text-gray-400 font-medium tracking-wide">{label}</p>}
    </div>
  );
}

export default LoadingSpinner;
