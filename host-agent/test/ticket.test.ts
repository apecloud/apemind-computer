import assert from "node:assert/strict"
import * as fs from "node:fs"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { signToken, verifyToken, type TokenType } from "../src/ticket.ts"

interface VectorCase {
  name: string
  type: TokenType
  token: string
  expect: { valid: boolean; user_id?: string; exp?: number; nonce?: string }
}

interface VectorFile {
  secret: string
  now: number
  cases: VectorCase[]
}

const vectorsPath = fileURLToPath(new URL("../../tests/vectors/tickets.json", import.meta.url))
const vectors = JSON.parse(fs.readFileSync(vectorsPath, "utf8")) as VectorFile

test("golden vectors from the Python signer verify identically", () => {
  for (const item of vectors.cases) {
    const result = verifyToken(item.token, vectors.secret, item.type, vectors.now)
    if (item.expect.valid) {
      assert.ok(result, `${item.name} should verify`)
      assert.equal(result.userId, item.expect.user_id, item.name)
      assert.equal(result.exp, item.expect.exp, item.name)
      if (item.expect.nonce) assert.equal(result.nonce, item.expect.nonce, item.name)
    } else {
      assert.equal(result, null, `${item.name} should be rejected`)
    }
  }
})

test("node sign/verify roundtrip matches the vector algorithm", () => {
  const now = 1_000_000
  const token = signToken("s3cret", { type: "ticket", userId: "user_1", exp: now + 60, nonce: "abcd" })
  const payload = verifyToken(token, "s3cret", "ticket", now)
  assert.ok(payload)
  assert.equal(payload.userId, "user_1")
  assert.equal(payload.nonce, "abcd")
  assert.equal(verifyToken(token, "s3cret", "session", now), null)
  assert.equal(verifyToken(token, "other-secret", "ticket", now), null)
  assert.equal(verifyToken(token, "s3cret", "ticket", now + 61), null)
})
