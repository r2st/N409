import type pg from 'pg';
import { problems } from '@n409/shared';
import { findPartnerById } from '../repos/adminUsers.js';

/**
 * The sentence every door that would file fresh work under a withdrawn firm
 * refuses in — `POST /valuations` wrote it first (R348), and the clone door
 * now reads the same one (R449).
 */
export const WITHDRAWN_FIRM_REFUSAL =
  'This firm has been withdrawn from the platform, so no new engagements can be created ' +
  'under it. Ask an administrator to restore it first.';

/**
 * Refuses to open an engagement under `partnerId` when that firm is archived.
 *
 * `partners.archived_at` is the firm's soft delete, and the rule it states —
 * a withdrawn firm acquires no fresh work — is asked at every door that files
 * an engagement under one: `POST /valuations`, the intake conversion (in its
 * own SQL), the partner API (at the key). A door that *copies* `partner_id`
 * off an existing row rather than taking it from the body or the principal
 * is the one that goes around all three, which is what the clone did.
 *
 * A null partner is every platform-side engagement and asks nothing.
 */
export async function refuseIfFirmWithdrawn(pool: pg.Pool, partnerId: string | null): Promise<void> {
  if (!partnerId) return;
  const partner = await findPartnerById(pool, partnerId);
  if (partner?.archived_at) throw problems.conflict(WITHDRAWN_FIRM_REFUSAL);
}
