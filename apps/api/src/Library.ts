import {
  type Category,
  type Feedback,
  type ItemId,
  ItemNotFound,
  type ItemPatch,
  type Status,
  UserItem,
  type UserId,
  UserNotFound
} from "@magpie/contract"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { ITEM_COLUMNS, type ItemRow, toItem } from "./Items.ts"

export interface Change {
  readonly interest?: 1 | -1
  readonly status?: Status | null
  readonly rating?: number | null
  readonly progress?: number | null
}

export interface EventSource {
  readonly source: string
  readonly sourceEventId: string
  readonly occurredAt?: Date
}

interface UserItemRow extends ItemRow {
  readonly status: Status | null
  readonly rating: number | null
  readonly progress: number | null
  readonly updated_at: Date
}

const toUserItem = (r: UserItemRow) =>
  new UserItem({
    item: toItem(r, r.rating !== null),
    status: r.status,
    rating: r.rating,
    progress: r.progress,
    updatedAt: r.updated_at.toISOString()
  })

export class Library extends Context.Service<Library, {
  feedback(userId: UserId, feedback: Feedback): Effect.Effect<void, UserNotFound | ItemNotFound>
  apply(userId: UserId, itemId: ItemId, change: Change, origin?: EventSource): Effect.Effect<void, UserNotFound | ItemNotFound>
  update(userId: UserId, itemId: ItemId, patch: ItemPatch): Effect.Effect<UserItem, UserNotFound | ItemNotFound>
  watchlist(userId: UserId, filter: { status?: Status | undefined; category?: Category | undefined }): Effect.Effect<ReadonlyArray<UserItem>, UserNotFound>
}>()("magpie/Library") {
  static readonly layer = Layer.effect(
    Library,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const ensureUser = Effect.fn(function*(userId: UserId) {
        const rows = yield* sql`SELECT 1 FROM app_user WHERE id::text = ${userId}`.pipe(Effect.orDie)
        if (rows.length === 0) return yield* new UserNotFound()
      })
      const ensureItem = Effect.fn(function*(itemId: ItemId) {
        const rows = yield* sql`SELECT 1 FROM item WHERE id = ${itemId}`.pipe(Effect.orDie)
        if (rows.length === 0) return yield* new ItemNotFound()
      })

      const apply = Effect.fn("Library.apply")(function*(userId: UserId, itemId: ItemId, change: Change, origin?: EventSource) {
        yield* ensureUser(userId)
        yield* ensureItem(itemId)
        const at = origin?.occurredAt ?? new Date()
        const events: Array<{ kind: string; value: number | null; status: Status | null }> = []
        if (change.interest !== undefined) events.push({ kind: change.interest > 0 ? "interested" : "not_interested", value: null, status: null })
        if (change.rating !== undefined) events.push({ kind: "rated", value: change.rating, status: null })
        if (change.status !== undefined) events.push({ kind: "status", value: null, status: change.status })
        if (change.progress !== undefined) events.push({ kind: "progress", value: change.progress, status: null })

        yield* sql.withTransaction(Effect.gen(function*() {
          for (const e of events) {
            const sourceEventId = origin ? `${origin.sourceEventId}:${e.kind}` : null
            yield* sql`
              INSERT INTO event (user_id, item_id, kind, value, status, source, source_event_id, occurred_at)
              VALUES (${userId}::uuid, ${itemId}, ${e.kind}::event_kind, ${e.value}, ${e.status}::item_status,
                      ${origin?.source ?? "app"}, ${sourceEventId}, ${at})
              ON CONFLICT (user_id, source, source_event_id) DO NOTHING`
          }
          yield* sql`
            INSERT INTO user_item (user_id, item_id, interest, status, rating, progress, updated_at)
            VALUES (${userId}::uuid, ${itemId}, ${change.interest ?? null}, ${change.status ?? null}::item_status,
                    ${change.rating ?? null}, ${change.progress ?? null}, ${at})
            ON CONFLICT (user_id, item_id) DO UPDATE SET
              interest = CASE WHEN ${change.interest !== undefined} THEN EXCLUDED.interest ELSE user_item.interest END,
              status = CASE
                WHEN ${change.status === undefined} THEN user_item.status
                -- Imports only move a title forward (want, then in progress or dropped, then finished). Manual edits can go anywhere.
                WHEN ${origin !== undefined}
                  AND (CASE user_item.status WHEN 'want' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'dropped' THEN 2 WHEN 'finished' THEN 3 ELSE 0 END)
                    > (CASE EXCLUDED.status WHEN 'want' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'dropped' THEN 2 WHEN 'finished' THEN 3 ELSE 0 END)
                  THEN user_item.status
                ELSE EXCLUDED.status END,
              rating = CASE WHEN ${change.rating !== undefined} THEN EXCLUDED.rating ELSE user_item.rating END,
              progress = CASE
                WHEN ${change.progress === undefined} THEN user_item.progress
                WHEN ${origin !== undefined} THEN GREATEST(user_item.progress, EXCLUDED.progress)
                ELSE EXCLUDED.progress END,
              updated_at = GREATEST(user_item.updated_at, EXCLUDED.updated_at)`
        })).pipe(Effect.orDie)
      })

      const feedback = Effect.fn("Library.feedback")(function*(userId: UserId, f: Feedback) {
        switch (f.kind) {
          case "interested":
            return yield* apply(userId, f.itemId, { interest: 1, status: "want" })
          case "not_interested":
            return yield* apply(userId, f.itemId, { interest: -1 })
          case "seen":
            return yield* apply(userId, f.itemId, { status: "finished", rating: f.rating ?? null })
        }
      })

      const fetchOne = Effect.fn(function*(userId: UserId, itemId: ItemId) {
        const rows = yield* sql.unsafe<UserItemRow>(
          `SELECT ${ITEM_COLUMNS}, ui.status::text AS status, ui.rating, ui.progress, ui.updated_at
           FROM user_item ui JOIN item i ON i.id = ui.item_id
           WHERE ui.user_id::text = $1 AND ui.item_id = $2`,
          [userId, itemId]
        ).pipe(Effect.orDie)
        return toUserItem(rows[0]!)
      })

      const update = Effect.fn("Library.update")(function*(userId: UserId, itemId: ItemId, patch: ItemPatch) {
        const change: { -readonly [K in keyof Change]: Change[K] } = {}
        if (patch.status !== undefined) change.status = patch.status
        if (patch.rating !== undefined) change.rating = patch.rating
        if (patch.progress !== undefined) change.progress = patch.progress
        yield* apply(userId, itemId, change)
        return yield* fetchOne(userId, itemId)
      })

      const watchlist = Effect.fn("Library.watchlist")(function*(
        userId: UserId,
        filter: { status?: Status | undefined; category?: Category | undefined }
      ) {
        yield* ensureUser(userId)
        const rows = yield* sql.unsafe<UserItemRow>(
          `SELECT ${ITEM_COLUMNS}, ui.status::text AS status, ui.rating, ui.progress, ui.updated_at
           FROM user_item ui JOIN item i ON i.id = ui.item_id
           WHERE ui.user_id::text = $1
             AND (ui.status IS NOT NULL OR ui.rating IS NOT NULL)
             AND ($2::item_status IS NULL OR ui.status = $2::item_status)
             AND ($3::category IS NULL OR i.category = $3::category)
           ORDER BY ui.updated_at DESC
           LIMIT 500`,
          [userId, filter.status ?? null, filter.category ?? null]
        ).pipe(Effect.orDie)
        return rows.map(toUserItem)
      })

      return Library.of({ feedback, apply, update, watchlist })
    })
  )
}
