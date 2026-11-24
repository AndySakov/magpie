import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Availability } from "../Availability.ts"
import { Tmdb } from "../Tmdb.ts"
import { PgLive } from "../Db.ts"
import { ingestAnime } from "./anime.ts"
import { ingestBooks } from "./books.ts"
import { ingestLanguages } from "./languages.ts"
import { finalize, rankQuality } from "./finalize.ts"
import { groupSeries } from "./series.ts"
import { ingestScreen } from "./screen.ts"
import { ingestTmdb } from "./tmdb.ts"

// Full availability sweep for every service users subscribe to. The hourly cron does the same 30 requests at a time.
const availability = Effect.flatMap(Effect.service(Availability), (a) => a.sweep(Number.POSITIVE_INFINITY)).pipe(
  Effect.flatMap((r) => Effect.log(`availability: ${r.requests} requests, ${r.finished} lists finished`)),
  Effect.provide(Availability.layer.pipe(Layer.provide(Tmdb.layer)))
)

const steps = {
  anime: ingestAnime(),
  screen: ingestScreen(),
  books: ingestBooks(),
  tmdb: ingestTmdb(),
  languages: ingestLanguages(),
  finalize: finalize(),
  quality: rankQuality(),
  series: groupSeries(),
  availability
}
type Step = keyof typeof steps

const requested = process.argv.slice(2) as Array<Step>
const run = requested.length > 0 ? requested : (Object.keys(steps) as Array<Step>)

Effect.forEach(run, (step) => steps[step].pipe(Effect.withLogSpan(step)), { discard: true }).pipe(
  Effect.provide(PgLive),
  NodeRuntime.runMain
)
