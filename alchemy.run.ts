import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Docker from "@alchemy.run/docker";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Magpie",
  {
    providers: Docker.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const user = yield* Config.String("POSTGRES_USER");
    const password = yield* Config.Redacted("POSTGRES_PASSWORD");
    const database = yield* Config.String("POSTGRES_DB");
    const port = yield* Config.Port("POSTGRES_PORT");
    const tag = yield* Config.String("POSTGRES_IMAGE_TAG");

    const image = yield* Docker.RemoteImage("Postgres", { name: "pgvector/pgvector", tag });
    const data = yield* Docker.Volume("PostgresData").pipe(RemovalPolicy.protect());

    const db = yield* Docker.Container("Db", {
      image,
      environment: { POSTGRES_USER: user, POSTGRES_PASSWORD: password, POSTGRES_DB: database },
      sharedMemorySize: "512m",
      ports: [{ external: port, internal: 5432 }],
      volumes: [{ hostPath: data.name, containerPath: "/var/lib/postgresql" }],
      start: true,
    });

    return { container: db.name, port };
  }),
);
