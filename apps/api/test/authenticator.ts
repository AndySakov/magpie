import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>

const head = (major: number, n: number) => {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 256) return Buffer.from([(major << 5) | 24, n])
  const b = Buffer.alloc(3)
  b[0] = (major << 5) | 25
  b.writeUInt16BE(n, 1)
  return b
}

const cbor = (v: Cbor): Buffer => {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)])
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])])
  return Buffer.concat([head(2, v.length), Buffer.from(v)])
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest()
const b64u = (data: string | Uint8Array) => Buffer.from(data).toString("base64url")

export class SoftAuthenticator {
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" })
  private readonly credentialId = randomBytes(16)
  private counter = 0
  private userHandle = ""

  constructor(
    private readonly rpId: string,
    private readonly origin: string
  ) {}

  private authData(flags: number, attestedCredential?: Buffer) {
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(this.counter)
    return Buffer.concat([sha256(this.rpId), Buffer.from([flags]), counter, ...(attestedCredential ? [attestedCredential] : [])])
  }

  register(options: { challenge: string; user: { id: string } }) {
    this.userHandle = options.user.id
    const jwk = this.keys.publicKey.export({ format: "jwk" })
    const coseKey = cbor(new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")]
    ]))
    const idLength = Buffer.alloc(2)
    idLength.writeUInt16BE(this.credentialId.length)
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, coseKey])
    const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin })
    const attestationObject = cbor(new Map<Cbor, Cbor>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", this.authData(0x45, attested)]
    ]))
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: "public-key",
      clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] }
    }
  }

  login(options: { challenge: string }) {
    this.counter += 1
    const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin })
    const authenticatorData = this.authData(0x05)
    const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.keys.privateKey)
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authenticatorData),
        signature: b64u(signature),
        userHandle: this.userHandle
      }
    }
  }
}
