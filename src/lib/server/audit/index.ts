/**
 * Audit log helper.
 *
 * Best-effort logger that records who did what to which entity. Never
 * throws into the calling action — the underlying insert is wrapped in
 * try/catch so a missing table or transient D1 error can't break the
 * primary write the user actually cares about.
 *
 * Action naming convention: `<entity>.<verb>` where the verb is short
 * and past tense-ish. Examples:
 *   - `article.create`, `article.update`, `article.publish`,
 *     `article.unpublish`, `article.delete`
 *   - `category.create`, `category.update`, `category.delete`
 *   - `tag.create`, `tag.update`, `tag.delete`
 *   - `media.delete`
 *   - `user.role_change`, `user.delete`
 *   - `invitation.create`, `invitation.accept`, `invitation.revoke`
 *   - `settings.update`
 */
import { drizzle } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import * as schema from "../content/schema";

/**
 * Actions that ship with core. Autocompletes in editors; a typo like
 * `article.publisj` will still error. Plugins register additional
 * actions via `AuditAction` (widened below) — this keeps the DX for
 * core call sites without blocking extensibility.
 */
export type KnownAuditAction =
  | `article.${"create" | "update" | "publish" | "unpublish" | "delete"}`
  | `category.${"create" | "update" | "delete"}`
  | `tag.${"create" | "update" | "delete"}`
  | `media.${"delete"}`
  | `user.${"role_change" | "delete"}`
  | `invitation.${"create" | "accept" | "revoke"}`
  | `settings.${"update"}`
  | `form.${"create" | "update" | "delete" | "submit"}`
  | `newsletter.${"subscribe" | "confirm" | "unsubscribe" | "delete" | "digest_sent"}`
  | `comment.${"create" | "approve" | "spam" | "archive" | "delete"}`;

/**
 * Any string a plugin may pass. The `& {}` intersection preserves
 * autocomplete for KnownAuditAction while accepting arbitrary strings
 * from plugins (e.g. `shop.order.paid`). Plugin actions MUST follow
 * the same `<entity>.<verb>` convention or `entityTypeOf` returns the
 * prefix as-is (still valid, still queryable).
 */
export type AuditAction = KnownAuditAction | (string & {});

/** Entity type derived from the action prefix. */
function entityTypeOf(action: AuditAction): string {
  return action.split(".")[0]!;
}

export async function logAudit(
  d1: D1Database,
  actorId: string | null,
  action: AuditAction,
  entityId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    const db = drizzle(d1, { schema });
    await db.insert(schema.auditLog).values({
      id: nanoid(),
      userId: actorId,
      action,
      entityType: entityTypeOf(action),
      entityId,
      metadata: Object.keys(metadata).length ? JSON.stringify(metadata) : null,
    });
  } catch {
    // Best-effort: a missing audit row is better than breaking a real action.
  }
}
