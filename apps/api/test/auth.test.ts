import { beforeAll, describe, expect, it } from "vitest"
import { SoftAuthenticator } from "./authenticator.ts"
import { API, call, cliInvite, join, ORIGIN, RP_ID, signIn, uniqueName } from "./client.ts"

const run = API ? describe : describe.skip

run("passkey auth", () => {
  let admin = ""
  beforeAll(async () => {
    const name = uniqueName("e2e-admin")
    const joined = await join(cliInvite("--admin"), name)
    expect(joined.status).toBe(200)
    expect(joined.body).toMatchObject({ name, isAdmin: true })
    admin = joined.session!
  })

  it("an invite link registers exactly one account", async () => {
    const invite = (await call("POST", "/invites", { body: {}, session: admin })).body.token
    const name = uniqueName("e2e")
    const first = await join(invite, name)
    expect(first.status).toBe(200)
    expect((await call("GET", "/me", { session: first.session! })).body).toMatchObject({ name, isAdmin: false })
    const second = await join(invite, uniqueName("e2e"))
    expect(second.status).toBe(404)
    expect(second.body._tag).toBe("InviteInvalid")
  })

  it("a returning friend signs in with their passkey, and signing out ends that session", async () => {
    const invite = (await call("POST", "/invites", { body: {}, session: admin })).body.token
    const joined = await join(invite, uniqueName("e2e"))
    const signedIn = await signIn(joined.key)
    expect(signedIn.status).toBe(200)
    expect(signedIn.body.id).toBe(joined.body.id)
    expect((await call("GET", "/me", { session: signedIn.session! })).status).toBe(200)
    expect((await call("POST", "/auth/logout", { session: signedIn.session! })).status).toBe(200)
    expect((await call("GET", "/me", { session: signedIn.session! })).status).toBe(401)
    expect((await call("GET", "/me", { session: joined.session! })).status).toBe(200)
  })

  it("rejects requests without a valid session", async () => {
    expect((await call("GET", "/me/deck?category=movie")).status).toBe(401)
    expect((await call("GET", "/me/deck?category=movie", { session: "forged" })).status).toBe(401)
    expect((await call("GET", "/search?q=heat")).status).toBe(401)
  })

  it("rejects a passkey answer signed for a different challenge", async () => {
    const invite = (await call("POST", "/invites", { body: {}, session: admin })).body.token
    const joined = await join(invite, uniqueName("e2e"))
    const signed = await call("POST", "/auth/login/options")
    const other = await call("POST", "/auth/login/options")
    const reply = await call("POST", "/auth/login", {
      body: { challengeId: other.body.challengeId, response: joined.key.login(signed.body.options) }
    })
    expect(reply.status).toBe(400)
    expect(reply.session).toBeNull()
  })

  it("rejects a passkey Magpie never registered", async () => {
    const reply = await signIn(new SoftAuthenticator(RP_ID, ORIGIN))
    expect(reply.status).toBe(400)
    expect(reply.body._tag).toBe("PasskeyRejected")
  })

  it("only admins can list members or invite", async () => {
    const invite = (await call("POST", "/invites", { body: {}, session: admin })).body.token
    const friend = (await join(invite, uniqueName("e2e"))).session!
    expect((await call("POST", "/invites", { body: {}, session: friend })).status).toBe(403)
    expect((await call("GET", "/users", { session: friend })).status).toBe(403)
    expect((await call("GET", "/users", { session: admin })).status).toBe(200)
  })

  it("refuses a name that is already taken", async () => {
    const taken = uniqueName("e2e")
    await join((await call("POST", "/invites", { body: {}, session: admin })).body.token, taken)
    const invite = (await call("POST", "/invites", { body: {}, session: admin })).body.token
    expect((await join(invite, taken.toUpperCase())).status).toBe(409)
  })

  it("refuses a name that differs only in case when both sign-ups started before either finished", async () => {
    const name = uniqueName("e2e")
    const key = new SoftAuthenticator(RP_ID, ORIGIN)
    const invite = (await call("POST", "/invites", { body: {}, session: admin })).body.token
    const options = await call("POST", "/auth/register/options", { body: { invite, name } })
    expect(options.status).toBe(200)
    const rival = (await call("POST", "/invites", { body: {}, session: admin })).body.token
    expect((await join(rival, name.toUpperCase())).status).toBe(200)
    const late = await call("POST", "/auth/register", {
      body: { challengeId: options.body.challengeId, response: key.register(options.body.options) }
    })
    expect(late.status).toBe(409)
    expect(late.body._tag).toBe("NameTaken")
  })

  it("a re-invite adds a second passkey to the same account", async () => {
    const name = uniqueName("e2e")
    const original = await join((await call("POST", "/invites", { body: {}, session: admin })).body.token, name)
    const reinvite = await call("POST", "/invites", { body: { forUserId: original.body.id }, session: admin })
    expect(reinvite.body.forName).toBe(name)
    expect((await call("POST", "/auth/invites/lookup", { body: { token: reinvite.body.token } })).body).toEqual({ forName: name })
    const replacement = await join(reinvite.body.token)
    expect(replacement.status).toBe(200)
    expect(replacement.body.id).toBe(original.body.id)
    expect((await signIn(original.key)).body.id).toBe(original.body.id)
    expect((await signIn(replacement.key)).body.id).toBe(original.body.id)
  })

  describe("adding a passkey for another device", () => {
    const friend = async () => join((await call("POST", "/invites", { body: {}, session: admin })).body.token, uniqueName("e2e"))
    const addKey = async (session: string, key: SoftAuthenticator, challengeId?: string) => {
      const options = await call("POST", "/me/passkeys/options", { session })
      return call("POST", "/me/passkeys", {
        session,
        body: { challengeId: challengeId ?? options.body.challengeId, response: key.register(options.body.options) }
      })
    }

    it("a signed-in friend saves a second passkey that signs in to the same account", async () => {
      const me = await friend()
      const laptop = new SoftAuthenticator(RP_ID, ORIGIN)
      expect((await addKey(me.session!, laptop)).status).toBe(200)
      expect((await signIn(laptop)).body.id).toBe(me.body.id)
      expect((await signIn(me.key)).body.id).toBe(me.body.id)
    })

    it("needs a session", async () => {
      expect((await call("POST", "/me/passkeys/options")).status).toBe(401)
    })

    it("refuses a passkey that is already saved", async () => {
      const me = await friend()
      const reply = await addKey(me.session!, me.key)
      expect(reply.status).toBe(400)
      expect(reply.body.message).toBe("This passkey is already saved in Magpie.")
    })

    it("won't accept another account's challenge", async () => {
      const mine = await friend()
      const theirs = await friend()
      const stolen = (await call("POST", "/me/passkeys/options", { session: theirs.session! })).body.challengeId
      const reply = await addKey(mine.session!, new SoftAuthenticator(RP_ID, ORIGIN), stolen)
      expect(reply.status).toBe(400)
    })

    it("its challenge can't be used to sign in", async () => {
      const me = await friend()
      const options = await call("POST", "/me/passkeys/options", { session: me.session! })
      const reply = await call("POST", "/auth/login", {
        body: { challengeId: options.body.challengeId, response: me.key.login(options.body.options) }
      })
      expect(reply.status).toBe(400)
    })
  })
})
