import { describe, expect, it } from 'vitest';
import CAMPAIGN from '../src/config/campaign.json';
import { availableStages, enter, newCampaign, secure, type Holding } from '../src/campaign/state';

const h = (stageId: string): Holding => ({ stageId, label: stageId, securedAt: 0, population: 1, buildings: 1, sites: {} });

describe('campaign graph', () => {
  it('every next points at a real stage and every stage is reachable from the start', () => {
    const ids = new Set(CAMPAIGN.stages.map((s) => s.id));
    for (const s of CAMPAIGN.stages) for (const n of s.next) expect(ids.has(n)).toBe(true);
    const seen = new Set([CAMPAIGN.start]);
    const queue = [CAMPAIGN.start];
    while (queue.length) {
      const id = queue.shift()!;
      for (const n of CAMPAIGN.stages.find((s) => s.id === id)!.next) if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
    expect(seen.size).toBe(ids.size);
  });

  it('starts in Forks with only Forks open', () => {
    const s = newCampaign();
    expect(s.current).toBe('forks');
    expect([...availableStages(s)]).toEqual(['forks']);
  });

  it('opens both I-5 directions after Olympia: the player chooses', () => {
    let s = newCampaign();
    for (const id of ['forks', 'montesano', 'olympia']) s = secure(s, h(id));
    const open = availableStages(s);
    expect(open.has('tacoma')).toBe(true);
    expect(open.has('centralia')).toBe(true);
    expect(open.has('seattle')).toBe(false);
    // going north does not close the south
    s = secure(enter(s, 'tacoma'), h('tacoma'));
    expect(availableStages(s).has('centralia')).toBe(true);
    expect(availableStages(s).has('seattle')).toBe(true);
  });

  it('refuses to enter a locked stage unless unlocked for dev', () => {
    const s = newCampaign();
    expect(enter(s, 'seattle').current).toBe('forks');
    expect(enter(s, 'seattle', true).current).toBe('seattle');
  });
});
