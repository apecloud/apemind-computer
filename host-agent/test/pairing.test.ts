import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { test } from "node:test"
import { loadConfig } from "../src/config.ts"
import { Control } from "../src/control.ts"
import { Gateway } from "../src/gateway.ts"
import { HostIdentity } from "../src/hoststate.ts"
import { signToken } from "../src/ticket.ts"
import { listen, makeEnv, TEST_CONTROL_TOKEN, TEST_ORIGIN, type TestEnv } from "./helpers.ts"

const UNPAIRED_ENV = { COMPUTER_TICKET_SECRET: "", COMPUTER_CONTROL_TOKEN: "" }

const JSON_HEADERS = { "content-type": "application/json" }

interface PairResponse {
  public_origin: string
  control_token: string
  ticket_secret: string
  paired_at: string
}

async function withControl(
  overrides: Record<string, string>,
  fn: (base: string, env: TestEnv) => Promise<void>,
): Promise<void> {
  const env = await makeEnv(overrides)
  const control = new Control(env.cfg, env.identity, env.sup)
  const port = await listen(control.server)
  try {
    await fn(`http://127.0.0.1:${port}`, env)
  } finally {
    control.server.close()
    await env.cleanup()
  }
}

function pairRequest(base: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/v1/pair`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ main_url: "http://paired-main.test" }),
    ...init,
  })
}

test("config rejects a lone pre-shared secret", () => {
  assert.throws(
    () =>
      loadConfig({
        COMPUTER_PUBLIC_ORIGIN: TEST_ORIGIN,
        COMPUTER_TICKET_SECRET: "only-one",
      }),
    /must be set together/,
  )
})

test("unpaired host: runtime is public, instances are locked", async () => {
  await withControl(UNPAIRED_ENV, async (base) => {
    const runtime = await fetch(`${base}/v1/runtime`)
    assert.equal(runtime.status, 200)
    const view = (await runtime.json()) as Record<string, unknown>
    assert.equal(view.state, "unpaired")
    assert.equal(view.public_origin, TEST_ORIGIN)
    assert.ok(view.version)
    assert.equal(view.control_token, undefined)
    assert.equal(view.ticket_secret, undefined)

    assert.equal((await fetch(`${base}/v1/instances`)).status, 401)
    assert.equal((await fetch(`${base}/healthz`)).status, 401)
  })
})

test("first-come pairing exchanges long-term secrets", async () => {
  await withControl(UNPAIRED_ENV, async (base, env) => {
    const res = await pairRequest(base)
    assert.equal(res.status, 200)
    const body = (await res.json()) as PairResponse
    assert.equal(body.public_origin, TEST_ORIGIN)
    assert.ok(body.control_token.length >= 32)
    assert.ok(body.ticket_secret.length >= 32)
    assert.ok(body.paired_at)

    const auth = { authorization: `Bearer ${body.control_token}` }
    assert.equal((await fetch(`${base}/healthz`, { headers: auth })).status, 200)
    assert.equal((await fetch(`${base}/v1/runtime`)).status, 401, "runtime requires auth once paired")
    const runtime = await fetch(`${base}/v1/runtime`, { headers: auth })
    const view = (await runtime.json()) as Record<string, unknown>
    assert.equal(view.state, "paired")
    assert.equal(view.main_url, "http://paired-main.test")
    assert.equal(view.paired_at, body.paired_at)

    assert.equal((await pairRequest(base)).status, 409, "second pair loses")
    assert.equal(env.identity.mode, "paired-file")
  })
})

test("pair rejects browser-shaped requests and bad bodies", async () => {
  await withControl(UNPAIRED_ENV, async (base) => {
    const withOrigin = await pairRequest(base, {
      headers: { ...JSON_HEADERS, origin: "http://evil.test" },
    })
    assert.equal(withOrigin.status, 403)

    const formPost = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ main_url: "http://paired-main.test" }),
    })
    assert.equal(formPost.status, 403)

    const badUrl = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ main_url: "ftp://nope" }),
    })
    assert.equal(badUrl.status, 400)

    const stillUnpaired = await fetch(`${base}/v1/runtime`)
    assert.equal(((await stillUnpaired.json()) as Record<string, unknown>).state, "unpaired")
  })
})

test("operator-set pair code gates pairing", async () => {
  await withControl({ ...UNPAIRED_ENV, COMPUTER_PAIR_CODE: "strict-code" }, async (base) => {
    assert.equal((await pairRequest(base)).status, 401)
    assert.equal(
      (await pairRequest(base, { headers: { ...JSON_HEADERS, authorization: "Bearer wrong" } })).status,
      401,
    )
    const ok = await pairRequest(base, {
      headers: { ...JSON_HEADERS, authorization: "Bearer strict-code" },
    })
    assert.equal(ok.status, 200)
  })
})

test("paired state survives a restart", async () => {
  await withControl(UNPAIRED_ENV, async (base, env) => {
    const body = (await (await pairRequest(base)).json()) as PairResponse

    const reloaded = new HostIdentity(env.cfg)
    assert.equal(reloaded.mode, "paired-file")
    const control = new Control(env.cfg, reloaded, env.sup)
    const port = await listen(control.server)
    try {
      const auth = { authorization: `Bearer ${body.control_token}` }
      const runtime = await fetch(`http://127.0.0.1:${port}/v1/runtime`, { headers: auth })
      assert.equal(runtime.status, 200)
      assert.equal(((await runtime.json()) as Record<string, unknown>).main_url, "http://paired-main.test")
    } finally {
      control.server.close()
    }
  })
})

test("main_url can be updated and unpair reopens pairing", async () => {
  await withControl(UNPAIRED_ENV, async (base) => {
    const body = (await (await pairRequest(base)).json()) as PairResponse
    const auth = { authorization: `Bearer ${body.control_token}` }

    const put = await fetch(`${base}/v1/runtime`, {
      method: "PUT",
      headers: { ...auth, ...JSON_HEADERS },
      body: JSON.stringify({ main_url: "http://moved-main.test" }),
    })
    assert.equal(put.status, 200)
    assert.equal(((await put.json()) as Record<string, unknown>).main_url, "http://moved-main.test")

    const badPut = await fetch(`${base}/v1/runtime`, {
      method: "PUT",
      headers: { ...auth, ...JSON_HEADERS },
      body: JSON.stringify({ main_url: "not-a-url" }),
    })
    assert.equal(badPut.status, 400)

    const unpair = await fetch(`${base}/v1/unpair`, { method: "POST", headers: auth })
    assert.equal(unpair.status, 200)
    assert.equal(((await unpair.json()) as Record<string, unknown>).state, "unpaired")
    assert.equal((await fetch(`${base}/healthz`, { headers: auth })).status, 401, "old token dies with unpair")

    const again = await pairRequest(base)
    assert.equal(again.status, 200)
    const next = (await again.json()) as PairResponse
    assert.notEqual(next.control_token, body.control_token)
  })
})

test("preshared env mode behaves as paired and refuses file mutations", async () => {
  await withControl({}, async (base, env) => {
    assert.equal(env.identity.mode, "preshared")
    const auth = { authorization: `Bearer ${TEST_CONTROL_TOKEN}` }

    assert.equal((await pairRequest(base)).status, 409)
    assert.equal((await fetch(`${base}/v1/runtime`)).status, 401)

    const runtime = await fetch(`${base}/v1/runtime`, { headers: auth })
    assert.equal(runtime.status, 200)
    const view = (await runtime.json()) as Record<string, unknown>
    assert.equal(view.state, "paired")
    assert.equal(view.main_url, "http://main.test")

    const put = await fetch(`${base}/v1/runtime`, {
      method: "PUT",
      headers: { ...auth, ...JSON_HEADERS },
      body: JSON.stringify({ main_url: "http://moved.test" }),
    })
    assert.equal(put.status, 409)
    assert.equal((await fetch(`${base}/v1/unpair`, { method: "POST", headers: auth })).status, 409)
  })
})

test("gateway uses pairing secrets and main_url", async () => {
  const env = await makeEnv(UNPAIRED_ENV)
  const control = new Control(env.cfg, env.identity, env.sup)
  const gateway = new Gateway(env.cfg, env.identity, env.sup)
  const controlPort = await listen(control.server)
  const gatewayPort = await listen(gateway.server)
  const controlBase = `http://127.0.0.1:${controlPort}`
  const gatewayBase = `http://127.0.0.1:${gatewayPort}`
  try {
    const beforePair = await fetch(`${gatewayBase}/`, { redirect: "manual", headers: { accept: "text/html" } })
    assert.equal(beforePair.status, 302)
    assert.match(beforePair.headers.get("location") ?? "", /^http:\/\/main\.test\//, "unpaired falls back to env main url")

    const body = (await (await pairRequest(controlBase)).json()) as PairResponse

    const nav = await fetch(`${gatewayBase}/`, { redirect: "manual", headers: { accept: "text/html" } })
    assert.equal(nav.headers.get("location"), "http://paired-main.test/workspace/computer")

    await env.sup.ensure("alice", "running")
    const ticket = signToken(body.ticket_secret, {
      type: "ticket",
      userId: "alice",
      exp: Math.floor(Date.now() / 1000) + 60,
      nonce: randomBytes(8).toString("hex"),
    })
    const redeem = await fetch(`${gatewayBase}/open/${ticket}`, { redirect: "manual" })
    assert.equal(redeem.status, 302)
    assert.equal(redeem.headers.get("location"), "/")
  } finally {
    control.server.close()
    gateway.server.close()
    await env.cleanup()
  }
})
