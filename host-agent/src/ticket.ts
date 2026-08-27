import { createHmac, timingSafeEqual } from "node:crypto"

export type TokenType = "ticket" | "session"

export interface TokenPayload {
  type: TokenType
  userId: string
  exp: number
  nonce?: string
}

export const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "ascii").digest("hex")
}

/** Verify a `v1.<b64url(json)>.<hmac-hex>` token. Returns null on any failure. */
export function verifyToken(token: string, secret: string, expected: TokenType, nowSec: number): TokenPayload | null {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) return null
  const parts = token.split(".")
  if (parts.length !== 3 || parts[0] !== "v1") return null
  const [, body, sig] = parts
  if (!/^[0-9a-f]{64}$/.test(sig)) return null
  const mac = hmacHex(secret, body)
  if (!timingSafeEqual(Buffer.from(sig, "ascii"), Buffer.from(mac, "ascii"))) return null
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (payload === null || typeof payload !== "object") return null
  const record = payload as Record<string, unknown>
  if (record.t !== expected) return null
  if (typeof record.u !== "string" || !USER_ID_RE.test(record.u)) return null
  if (typeof record.e !== "number" || !Number.isInteger(record.e) || record.e <= nowSec) return null
  if (expected === "ticket" && (typeof record.n !== "string" || record.n.length === 0)) return null
  return {
    type: expected,
    userId: record.u,
    exp: record.e,
    nonce: typeof record.n === "string" ? record.n : undefined,
  }
}

export function signToken(secret: string, payload: TokenPayload): string {
  const record: Record<string, unknown> = { t: payload.type, u: payload.userId, e: payload.exp }
  if (payload.nonce !== undefined) record.n = payload.nonce
  const body = Buffer.from(JSON.stringify(record), "utf8").toString("base64url")
  return `v1.${body}.${hmacHex(secret, body)}`
}
