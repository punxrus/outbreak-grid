import UNITS from '../config/units.json';
import type { BattleStats, Placement, UnitKind } from '../sim/types';

export type Resources = Record<string, number>;
type UnitSpec = { label: string; color: string; cost?: Resources; dots?: number };
const SPEC = UNITS.units as Record<string, UnitSpec>;
const RES_LABEL: Record<string, string> = { survivors: 'Survivors', ammo: 'Ammo', fuel: 'Fuel', medical: 'Medical', food: 'Food' };

export const affordable = (pool: Resources, kind: string) =>
  Object.entries(SPEC[kind]!.cost ?? {}).every(([r, n]) => (pool[r] ?? 0) >= n);
export const costText = (kind: string) => Object.entries(SPEC[kind]!.cost ?? {}).map(([r, n]) => `${n} ${r}`).join(' · ');

interface Props {
  phase: 'prep' | 'battle';
  ready: boolean;
  pool: Resources;
  placements: Placement[];
  armed: UnitKind | null;
  stats: BattleStats | null;
  speed: number;
  onArm: (k: UnitKind | null) => void;
  onUndo: () => void;
  onStart: () => void;
  onSpeed: (s: number) => void;
  onAbort: () => void;
}

/** Prep: spend the pool by placing squads. Battle: watch, change speed. */
export function BattlePanel(p: Props) {
  return (
    <aside className="battle">
      <h3>{p.phase === 'prep' ? 'DEPLOY FORCES' : 'BATTLE'}</h3>
      <div className="pool">
        {Object.keys(RES_LABEL).map((r) => (
          <div key={r} className="res"><label>{RES_LABEL[r]}</label>{(p.pool[r] ?? 0).toLocaleString()}</div>
        ))}
      </div>

      {p.phase === 'prep' ? (
        <>
          <div className="units">
            {(UNITS.placeable as UnitKind[]).map((k) => {
              const ok = affordable(p.pool, k);
              return (
                <button key={k} className={p.armed === k ? 'on' : ''} disabled={!ok || !p.ready} onClick={() => p.onArm(p.armed === k ? null : k)} title={`${SPEC[k]!.dots ?? 1} per squad`}>
                  <span className="unit"><i style={{ background: SPEC[k]!.color }} />{SPEC[k]!.label}</span>
                  <span className="cost">{costText(k)}</span>
                </button>
              );
            })}
          </div>
          <div className="hint">
            {!p.ready ? 'Building the region…' : p.armed ? `Click the map to place ${SPEC[p.armed]!.label}. Esc to cancel.` : 'Pick a unit, then click the map to place it.'}
          </div>
          <div className="row">
            <button disabled={!p.placements.length} onClick={p.onUndo}>Undo</button>
            <button className="go" disabled={!p.ready} onClick={p.onStart}>Start battle ▶</button>
          </div>
        </>
      ) : (
        <>
          {p.stats && (
            <div className="live">
              <div><i style={{ background: SPEC.zombie!.color }} />Zombies <b>{p.stats.zombies}</b></div>
              <div><i style={{ background: SPEC.survivor!.color }} />Survivors <b>{p.stats.survivors}</b> <span className="muted">/ {p.stats.survivorsStart} ({pct(p.stats)}%)</span></div>
              <div>Forces <b>{p.stats.defenders}</b> · Ammo <b>{p.stats.ammo}</b> · Kills <b>{p.stats.killed}</b></div>
              <div className="muted">{fmtTime(p.stats.time)}</div>
            </div>
          )}
          <div className="row speeds">
            {[0, 1, 2, 4, 8].map((s) => <button key={s} className={p.speed === s ? 'on' : ''} onClick={() => p.onSpeed(s)}>{s === 0 ? '❚❚' : `${s}×`}</button>)}
          </div>
          <button onClick={p.onAbort}>Retreat (back to deployment)</button>
        </>
      )}
    </aside>
  );
}

export const pct = (s: BattleStats) => (s.survivorsStart ? Math.round((s.survivors / s.survivorsStart) * 100) : 100);
const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
