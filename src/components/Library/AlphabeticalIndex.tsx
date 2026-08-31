const ALPHABET = 'ALL,A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X,Y,Z,#'.split(',');

interface AlphabeticalIndexProps {
  activeLetter: string;
  onSelectLetter: (letter: string) => void;
  availableLetters?: Set<string>;
}

export function AlphabeticalIndex({
  activeLetter,
  onSelectLetter,
  availableLetters,
}: AlphabeticalIndexProps) {
  return (
    <div className="w-full overflow-x-auto scrollbar-none py-1">
      <div className="flex items-center gap-1.5 min-w-max px-1">
        {ALPHABET.map((letter) => {
          const isAll = letter === 'ALL';
          const isSelected = activeLetter === letter || (isAll && !activeLetter);
          const isAvailable =
            isAll ||
            !availableLetters ||
            availableLetters.size === 0 ||
            availableLetters.has(letter);

          return (
            <button
              key={letter}
              type="button"
              onClick={() => onSelectLetter(isAll ? '' : letter)}
              disabled={!isAvailable}
              className={`h-7 px-2.5 rounded-lg text-xs font-semibold transition-all cursor-pointer select-none flex items-center justify-center ${
                isSelected
                  ? 'bg-[var(--color-crystal-cyan)] text-black shadow-[0_0_12px_rgba(0,229,255,0.4)]'
                  : isAvailable
                  ? 'bg-[var(--color-crystal-surface)] hover:bg-white/10 text-gray-300 hover:text-white border border-[var(--color-crystal-border)]/60'
                  : 'text-gray-600 opacity-40 cursor-not-allowed'
              }`}
            >
              {letter}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default AlphabeticalIndex;
