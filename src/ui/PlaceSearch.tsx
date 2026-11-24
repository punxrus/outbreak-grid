import { useMemo, useState } from 'react';
import type { Place } from '../geo/types';

interface Props {
  places: Place[];
  onPick: (p: Place) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

/** Search box over places.json (cities, towns, CDPs), ranked by prefix match then population. */
export function PlaceSearch({ places, onPick, inputRef }: Props) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const starts: Place[] = [];
    const contains: Place[] = [];
    for (const p of places) {
      const n = p.name.toLowerCase();
      if (n.startsWith(s)) starts.push(p);
      else if (n.includes(s)) contains.push(p);
      if (starts.length >= 8) break;
    }
    return [...starts, ...contains].slice(0, 8); // places.json is already sorted by population
  }, [q, places]);

  const pick = (p: Place) => {
    onPick(p);
    setQ('');
    inputRef?.current?.blur();
  };

  return (
    <div className="search">
      <input
        ref={inputRef}
        value={q}
        placeholder="Search city or town  ( / )"
        spellCheck={false}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { setActive((a) => Math.min(results.length - 1, a + 1)); e.preventDefault(); }
          if (e.key === 'ArrowUp') { setActive((a) => Math.max(0, a - 1)); e.preventDefault(); }
          if (e.key === 'Enter' && results[active]) pick(results[active]);
          if (e.key === 'Escape') { setQ(''); e.currentTarget.blur(); }
          e.stopPropagation();
        }}
      />
      {results.length > 0 && (
        <ul>
          {results.map((p, i) => (
            <li key={p.geoid} className={i === active ? 'active' : ''} onMouseDown={() => pick(p)}>
              <span>{p.name}</span>
              <span className="muted">
                {p.kind === 'cdp' ? 'CDP' : p.kind} · {p.pop.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
