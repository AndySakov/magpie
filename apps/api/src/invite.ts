import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { parseArgs } from "node:util"
import { AuthConfig, insertInvite } from "./Auth.ts"
import { PgLive } from "./Db.ts"

const { values } = parseArgs({
  options: { admin: { type: "boolean", default: false }, user: { type: "string" } }
})

const program = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const { origin } = yield* AuthConfig
  let forUserId: string | undefined
  if (values.user !== undefined) {
    const rows = yield* sql<{ id: string }>`SELECT id::text FROM app_user WHERE lower(name) = lower(${values.user})`
    if (rows.length === 0) return yield* Effect.fail(new Error(`No user named ${values.user}`))
    forUserId = rows[0]!.id
  }
  const invite = yield* insertInvite(sql, { forUserId, isAdmin: values.admin, createdBy: null })
  console.log(`${origin}/#join=${invite.token}`)
  console.log(`expires ${invite.expiresAt}${invite.forName ? `, signs in as ${invite.forName}` : ""}${values.admin ? ", admin" : ""}`)
})

program.pipe(Effect.provide(PgLive), NodeRuntime.runMain)
