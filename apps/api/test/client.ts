import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { SoftAuthenticator } from "./authenticator.ts"

export const API = process.env.API_URL
export const RP_ID = process.env.RP_ID ?? "localhost"
export const ORIGIN = process.env.ORIGIN ?? "http://localhost:5173"

export type Reply = { status: number; body: any; session: string | null }

export const call = async (
  method: string,
  path: string,
  opts: { body?: unknown; session?: string } = {}
): Promise<Reply> => {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.session === undefined ? {} : { cookie: `magpie_session=${opts.session}` })
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) })
  })
  const text = await res.text()
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("magpie_session="))
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    session: cookie ? cookie.split(";")[0]!.slice("magpie_session=".length) : null
  }
}

export const cliInvite = (...args: Array<string>) => {
  const out = execFileSync("pnpm", ["-s", "invite", ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8"
  })
  return out.match(/#join=([\w-]+)/)![1]!
}

export const join = async (invite: string, name?: string) => {
  const key = new SoftAuthenticator(RP_ID, ORIGIN)
  const options = await call("POST", "/auth/register/options", { body: { invite, ...(name === undefined ? {} : { name }) } })
  if (options.status !== 200) return { key, ...options }
  const reply = await call("POST", "/auth/register", {
    body: { challengeId: options.body.challengeId, response: key.register(options.body.options) }
  })
  return { key, ...reply }
}

export const signIn = async (key: SoftAuthenticator) => {
  const options = await call("POST", "/auth/login/options")
  return call("POST", "/auth/login", { body: { challengeId: options.body.challengeId, response: key.login(options.body.options) } })
}

export const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

export const newAdmin = async () => {
  const admin = await join(cliInvite("--admin"), uniqueName("e2e-admin"))
  return admin.session!
}

export const newUser = async (adminSession: string) => {
  const invite = await call("POST", "/invites", { body: {}, session: adminSession })
  return (await join(invite.body.token, uniqueName("e2e"))).session!
}

export const localSql = (query: string) =>
  execFileSync("sh", ["-c", 'set -a; . ../../.env; set +a; psql "$DATABASE_URL" -qAt -v ON_ERROR_STOP=1 -c "$1"', "sh", query], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8"
  }).trim()
