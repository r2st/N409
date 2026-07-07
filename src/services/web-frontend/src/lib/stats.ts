import { stateGroup } from './format';
import type { Valuation } from './types';

export interface DashboardStats {
  total: number;
  open: number;
  inReview: number;
  drafted: number;
  published: number;
  waitingOnClient: number;
}

/** Quick stats computed client-side from the (scoped) valuation list. */
export function computeStats(valuations: Valuation[]): DashboardStats {
  const stats: DashboardStats = {
    total: valuations.length,
    open: 0,
    inReview: 0,
    drafted: 0,
    published: 0,
    waitingOnClient: 0,
  };
  for (const v of valuations) {
    switch (stateGroup(v.state)) {
      case 'open':
        stats.open += 1;
        break;
      case 'in_review':
        stats.inReview += 1;
        break;
      case 'drafted':
        stats.drafted += 1;
        break;
      case 'published':
        stats.published += 1;
        break;
      case 'closed':
        break;
    }
    if (v.waiting_on_client) stats.waitingOnClient += 1;
  }
  return stats;
}
