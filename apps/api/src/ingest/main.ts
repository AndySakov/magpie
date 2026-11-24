import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { PgLive } from "../Db.ts"
import { ingestAnime } from "./anime.ts"
import { ingestBooks } from "./books.ts"
import { ingestLanguages } from "./languages.ts"
import { finalize } from "./finalize.ts"
import { ingestScreen } from "./screen.ts"
import { ingestTmdb } from "./tmdb.ts"

const steps = { anime: ingestAnime(), screen: ingestScreen(), books: ingestBooks(), tmdb: ingestTmdb(), languages: ingestLanguages(), finalize: finalize() }
type Step = keyof typeof steps

const requested = process.argv.slice(2) as Array<Step>
const run = requested.length > 0 ? requested : (Object.keys(steps) as Array<Step>)

Effect.forEach(run, (step) => steps[step].pipe(Effect.withLogSpan(step)), { discard: true }).pipe(
  Effect.provide(PgLive),
  NodeRuntime.runMain
)
