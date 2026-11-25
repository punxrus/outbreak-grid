import UNITS from '../config/units.json';
import type { BattleStats, Placement, UnitKind } from '../sim/types';

export type Resources = Record<string, number>;
type UnitSpec = { label: string; color: string; cost?: Resources; dots?: number };
const SPEC = UNITS.units as Record<string, UnitSpec>;
const RES_LABEL: Record<string, string> = { money: 'Money', survivors: 'Survivors', ammo: 'Ammo', fuel: 'Fuel', medical: 'Medical', food: 'Food' };
export type Tool = UnitKind | 'zone' | 'gate';

export const affordable = (pool: Resources, kind: string) =>
  Object.entries(SPEC[kind]!.cost ?? {}).every(([r, n]) => (pool[r] ?? 0) >= n);
export const costText = (kind: string) => Object.entries(SPEC[kind]!.cost ?? {}).map(([r, n]) => `${n} ${r}`).join(' · ');

interface Props {
  phase: 'prep' | 'battle';
  ready: boolean;
  pool: Resources;
  placements: Placement[];
  armed: Tool | null;
  /** Live cost of the zone being drawn (money), if any. */
  draftCost: number | null;
  hasZone: boolean;
  /** Unit -> max squads this stage (missing = locked); null = everything available. */
  roster: Record<string, number> | null;
  stats: BattleStats | null;
  speed: number;
  onArm: (k: Tool | null) => void;
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
          <div key={r} className="res"><label>{RES_LABEL[r]}</label>{r === 'money' ? '$' : ''}{(p.pool[r] ?? 0).toLocaleString()}</div>
        ))}
      </div>

      {p.phase === 'prep' ? (
        <>
          <div className="units build">
            <button className={p.armed === 'zone' ? 'on' : ''} disabled={!p.ready} onClick={() => p.onArm(p.armed === 'zone' ? null : 'zone')} title="Click points around an area; click the first point (or Enter) to close">
              <span className="unit"><i style={{ background: '#2fe6ff' }} />Safe zone walls</span>
              <span className="cost">{'$'}{UNITS.walls.costPerMeter}/m · buildings free</span>
            </button>
            <button className={p.armed === 'gate' ? 'on' : ''} disabled={!p.ready || !p.hasZone || (p.pool.money ?? 0) < UNITS.walls.gateCost} onClick={() => p.onArm(p.armed === 'gate' ? null : 'gate')} title="Click on a wall to put a gate in it">
              <span className="unit"><i style={{ background: '#ffffff' }} />Gate</span>
              <span className="cost">{'$'}{UNITS.walls.gateCost} each</span>
            </button>
          </div>
          <div className="units">
            {(UNITS.placeable as UnitKind[]).filter((k) => !p.roster || k in p.roster).map((k) => {
              const used = p.placements.filter((q) => q.kind === k).length;
              const max = p.roster?.[k];
              const ok = affordable(p.pool, k) && (max === undefined || used < max);
              return (
                <button key={k} className={p.armed === k ? 'on' : ''} disabled={!ok || !p.ready} onClick={() => p.onArm(p.armed === k ? null : k)} title={`${SPEC[k]!.dots ?? 1} per squad`}>
                  <span className="unit"><i style={{ background: SPEC[k]!.color }} />{SPEC[k]!.label}{max !== undefined ? ` (${used}/${max})` : ''}</span>
                  <span className="cost">{costText(k)}</span>
                </button>
              );
            })}
            {p.roster && <div className="hint note">More forces unlock as the campaign goes on.</div>}
          </div>
          <div className="hint">
            {!p.ready ? 'Building the region…'
              : p.armed === 'zone' ? 'Click points around the area; click the first point or press Enter to close. Esc cancels.' + (p.draftCost !== null ? ' Walls so far: $' + p.draftCost.toLocaleString() : '')
              : p.armed === 'gate' ? 'Click on a wall to add a gate. People pass, zombies do not.'
              : p.armed ? 'Click the map to place ' + SPEC[p.armed]!.label + '. Esc to cancel.'
              : 'Pick a unit or build a safe zone, then click the map.'}
          </div>
          <div className="row">
            <button onClick={p.onUndo}>Undo</button>
            <button className="go" disabled={!p.ready} onClick={p.onStart}>Start battle ▶</button>
          </div>
        </>
      ) : (
        <>
          {p.stats && (
            <div className="live">
              <div><i style={{ background: SPEC.zombie!.color }} />Zombies <b>{p.stats.zombies}</b></div>
              <div><i style={{ background: SPEC.survivor!.color }} />Survivors <b>{p.stats.survivors}</b> <span className="muted">/ {p.stats.survivorsStart} ({pct(p.stats)}%)</span></div>
              <div>Forces <b>{p.stats.defenders}</b> · Ammo carried <b>{p.stats.ammo}</b> · reserve <b>{p.stats.reserve}</b> · Kills <b>{p.stats.killed}</b></div>
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
