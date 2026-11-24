import * as Alchemy from "alchemy"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"

export default Alchemy.Stack(
  "MagpieCloud",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState()
  },
  Effect.gen(function*() {
    const domain = yield* Config.String("APP_DOMAIN")
    const prod = new URL(Redacted.value(yield* Config.Redacted("PROD_DATABASE_URL")))

    const db = yield* Cloudflare.Hyperdrive.Connection("Db", {
      origin: {
        scheme: "postgres",
        host: prod.hostname,
        port: Number(prod.port || 5432),
        database: prod.pathname.slice(1),
        user: decodeURIComponent(prod.username),
        password: Redacted.make(decodeURIComponent(prod.password))
      },
      caching: { disabled: true },
      dev: {
        scheme: "postgres",
        host: "localhost",
        port: yield* Config.Port("POSTGRES_PORT"),
        database: yield* Config.String("POSTGRES_DB"),
        user: yield* Config.String("POSTGRES_USER"),
        password: yield* Config.Redacted("POSTGRES_PASSWORD"),
        sslmode: "disable"
      }
    })

    // Usage alerts read Cloudflare analytics with a read-only token and mail through Email Routing.
    // Both are optional: without them the hourly check only logs warnings.
    const analyticsToken = yield* Config.option(Config.Redacted("CF_ANALYTICS_TOKEN"))
    // Optional: without it the Trakt integration is hidden. Trakt sign-in uses PKCE, so no client secret is needed.
    const traktClientId = yield* Config.option(Config.String("TRAKT_CLIENT_ID"))
    const alertTo = yield* Config.option(Config.String("ALERT_EMAIL_TO"))
    const alertFrom = yield* Config.option(Config.String("ALERT_EMAIL_FROM"))
    const mail = Option.isSome(alertTo) && Option.isSome(alertFrom)
      ? yield* Effect.gen(function*() {
        yield* Cloudflare.Email.Routing("AlertRouting", { zone: alertFrom.value.split("@")[1]! })
        yield* Cloudflare.Email.Address("AlertAddress", { email: alertTo.value })
        return {
          EMAIL: Cloudflare.Email.SendEmail("Email", { destinationAddress: alertTo.value, allowedSenderAddresses: [alertFrom.value] }),
          ALERT_EMAIL_TO: alertTo.value,
          ALERT_EMAIL_FROM: alertFrom.value
        }
      })
      : {}

    const worker = yield* Cloudflare.Worker("Magpie", {
      main: "apps/api/src/worker.ts",
      compatibility: { date: "2026-07-01" },
      assets: {
        directory: "apps/web/dist",
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/api/*"]
      },
      domain,
      crons: ["0 * * * *", "30 * * * *"],
      env: {
        ...mail,
        ...(Option.isSome(analyticsToken) ? { CF_ANALYTICS_TOKEN: analyticsToken.value } : {}),
        ...(Option.isSome(traktClientId) && traktClientId.value.trim() !== "" ? { TRAKT_CLIENT_ID: traktClientId.value.trim() } : {}),
        HYPERDRIVE: db,
        AI: Cloudflare.Workers.AI(),
        RP_ID: domain,
        ORIGIN: `https://${domain}`,
        TMDB_API_TOKEN: yield* Config.Redacted("TMDB_API_TOKEN")
      }
    })

    return { url: worker.url }
  })
)
