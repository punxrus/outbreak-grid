import CAMPAIGN from '../config/campaign.json';
import type { LandmarkType } from '../procgen/types';
import { STAGES, type Stage } from './region';

/**
 * What a secured region contributes after the player moves on. Nothing is
 * rendered or kept in memory for it: this snapshot is the asset. Production
 * rules come with the economy milestone and read from these counts.
 */
export interface Holding {
  stageId: string;
  label: string;
  securedAt: number; // ms epoch
  population: number; // 2020 Census population of the place
  buildings: number;
  sites: Partial<Record<LandmarkType, number>>;
}

export interface CampaignState {
  version: 1;
  current: string;
  holdings: Record<string, Holding>; // by stage id
}

const KEY = 'outbreak-grid.campaign.v1';

export function newCampaign(): CampaignState {
  return { version: 1, current: CAMPAIGN.start, holdings: {} };
}

/**
 * Stages the player may enter: the start, everything already secured, and the
 * next stages of every secured one. Branches (Olympia -> Tacoma or Centralia)
 * fall out of the graph: both open, the player chooses.
 */
export function availableStages(s: CampaignState): Set<string> {
  const out = new Set<string>([CAMPAIGN.start]);
  for (const id of Object.keys(s.holdings)) {
    out.add(id);
    for (const n of stage(id)?.next ?? []) out.add(n);
  }
  return out;
}

export function isSecured(s: CampaignState, id: string): boolean {
  return id in s.holdings;
}

export function secure(s: CampaignState, h: Holding): CampaignState {
  return { ...s, holdings: { ...s.holdings, [h.stageId]: h } };
}

export function enter(s: CampaignState, id: string, unlockAll = false): CampaignState {
  if (!unlockAll && !availableStages(s).has(id)) return s;
  return { ...s, current: id };
}

const stage = (id: string): Stage | undefined => STAGES.find((st) => st.id === id);

/** Browser storage is a convenience until the save system (M7): never trusted, never required. */
export function loadCampaign(): CampaignState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return newCampaign();
    const s = JSON.parse(raw) as CampaignState;
    if (s.version !== 1 || !stage(s.current) || typeof s.holdings !== 'object') return newCampaign();
    for (const id of Object.keys(s.holdings)) if (!stage(id)) delete s.holdings[id];
    return s;
  } catch {
    return newCampaign();
  }
}

export function saveCampaign(s: CampaignState): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable: play on without saving */ }
}
