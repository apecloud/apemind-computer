import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import * as net from "node:net"
import { test } from "node:test"
import { Gateway, SESSION_COOKIE } from "../src/gateway.ts"
import { signToken } from "../src/ticket.ts"
import { listen, makeEnv, TEST_ORIGIN, TEST_SECRET, type TestEnv } from "./helpers.ts"

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function mintTicket(userId: string, expOffsetSec = 60): string {
  return signToken(TEST_SECRET, {
    type: "ticket",
    userId,
    exp: nowSec() + expOffsetSec,
    nonce: randomBytes(8).toString("hex"),
  })
}

function cookieFromResponse(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? ""
  const pair = setCookie.split(";")[0]
  assert.ok(pair.startsWith(`${SESSION_COOKIE}=`), `unexpected set-cookie: ${setCookie}`)
  return pair
}

async function withGateway(fn: (base: string, env: TestEnv) => Promise<void>): Promise<void> {
  const env = await makeEnv()
  const gateway = new Gateway(env.cfg, env.identity, env.sup)
  const port = await listen(gateway.server)
  try {
    await fn(`http://127.0.0.1:${port}`, env)
  } finally {
    gateway.server.close()
    await env.cleanup()
  }
}

test("open flow: ticket redeems once, session cookie proxies to the tenant dsh", async () => {
  await withGateway(async (base, env) => {
    await env.sup.ensure("alice", "running")
    const ticket = mintTicket("alice")

    const redeem = await fetch(`${base}/open/${ticket}`, { redirect: "manual" })
    assert.equal(redeem.status, 302)
    assert.equal(redeem.headers.get("location"), "/")
    const cookie = cookieFromResponse(redeem)

    const replay = await fetch(`${base}/open/${ticket}`, { redirect: "manual" })
    assert.equal(replay.status, 403)

    const whoami = await fetch(`${base}/whoami`, { headers: { cookie } })
    assert.equal(whoami.status, 200)
    const body = (await whoami.json()) as Record<string, unknown>
    assert.match(String(body.host), /^127\.0\.0\.1:\d+$/)
    assert.equal(body.origin, null)
    assert.equal(body.cookie, null, "session cookie must not reach dsh")
    assert.equal(body.encoding, "identity")
  })
})

test("requests without a valid session are redirected or denied", async () => {
  await withGateway(async (base) => {
    const nav = await fetch(`${base}/`, { redirect: "manual", headers: { accept: "text/html" } })
    assert.equal(nav.status, 302)
    assert.match(nav.headers.get("location") ?? "", /^http:\/\/main\.test\//)

    const xhr = await fetch(`${base}/api/thing`, { redirect: "manual" })
    assert.equal(xhr.status, 401)

    const forged = signToken("wrong-secret", { type: "session", userId: "alice", exp: nowSec() + 600 })
    const res = await fetch(`${base}/api/thing`, { headers: { cookie: `${SESSION_COOKIE}=${forged}` } })
    assert.equal(res.status, 401)

    const expired = signToken(TEST_SECRET, { type: "session", userId: "alice", exp: nowSec() - 1 })
    const res2 = await fetch(`${base}/api/thing`, { headers: { cookie: `${SESSION_COOKIE}=${expired}` } })
    assert.equal(res2.status, 401)

    const ticketAsSession = mintTicket("alice")
    const res3 = await fetch(`${base}/api/thing`, { headers: { cookie: `${SESSION_COOKIE}=${ticketAsSession}` } })
    assert.equal(res3.status, 401)
  })
})

test("cross-origin browser requests are rejected before proxying", async () => {
  await withGateway(async (base, env) => {
    await env.sup.ensure("alice", "running")
    const redeem = await fetch(`${base}/open/${mintTicket("alice")}`, { redirect: "manual" })
    const cookie = cookieFromResponse(redeem)

    const evil = await fetch(`${base}/whoami`, { headers: { cookie, origin: "http://evil.test" } })
    assert.equal(evil.status, 403)

    const good = await fetch(`${base}/whoami`, { headers: { cookie, origin: TEST_ORIGIN } })
    assert.equal(good.status, 200)
  })
})

test("session of one user cannot reach another tenant", async () => {
  await withGateway(async (base, env) => {
    await env.sup.ensure("alice", "running")
    await env.sup.ensure("bob", "running")
    const bobCookie = cookieFromResponse(await fetch(`${base}/open/${mintTicket("bob")}`, { redirect: "manual" }))
    const whoami = await fetch(`${base}/whoami`, { headers: { cookie: bobCookie } })
    const body = (await whoami.json()) as Record<string, string>
    assert.equal(body.host, `127.0.0.1:${env.sup.getView("bob")?.port}`)
    assert.notEqual(body.host, `127.0.0.1:${env.sup.getView("alice")?.port}`)
  })
})

test("idle-stopped instance wakes on the next authenticated request", async () => {
  await withGateway(async (base, env) => {
    await env.sup.ensure("alice", "running")
    const cookie = cookieFromResponse(await fetch(`${base}/open/${mintTicket("alice")}`, { redirect: "manual" }))
    // simulate the idle reaper: process stopped, desired stays running
    await env.sup.ensure("alice", "running")
    const inst = env.sup.get("alice")
    assert.ok(inst)
    await (env.sup as unknown as { stopProcess: (i: unknown) => Promise<void> }).stopProcess(inst)
    assert.equal(env.sup.getView("alice")?.status, "stopped")

    const res = await fetch(`${base}/whoami`, { headers: { cookie } })
    assert.equal(res.status, 200)
    assert.equal(env.sup.getView("alice")?.status, "running")
  })
})

test("user-stopped instance does not wake from the gateway", async () => {
  await withGateway(async (base, env) => {
    await env.sup.ensure("alice", "running")
    const cookie = cookieFromResponse(await fetch(`${base}/open/${mintTicket("alice")}`, { redirect: "manual" }))
    await env.sup.ensure("alice", "stopped")

    const res = await fetch(`${base}/whoami`, { headers: { cookie } })
    assert.equal(res.status, 503)
    assert.equal(env.sup.getView("alice")?.status, "stopped")
  })
})

test("websocket upgrade reaches dsh with rewritten host and echoes data", async () => {
  await withGateway(async (base, env) => {
    await env.sup.ensure("alice", "running")
    const cookie = cookieFromResponse(await fetch(`${base}/open/${mintTicket("alice")}`, { redirect: "manual" }))
    const port = Number.parseInt(new URL(base).port, 10)

    const wsKey = randomBytes(16).toString("base64")
    const expectedAccept = createHash("sha1").update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    const socket = net.connect({ host: "127.0.0.1", port })
    const handshake = [
      "GET /api/events.mux HTTP/1.1",
      `Host: computer.test`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${wsKey}`,
      `Origin: ${TEST_ORIGIN}`,
      `Cookie: ${cookie}`,
      "",
      "",
    ].join("\r\n")

    const result = await new Promise<{ status: number; accept: string | null; echoed: boolean }>((resolve, reject) => {
      let buffer = ""
      let upgraded = false
      const timer = setTimeout(() => reject(new Error(`ws timeout, got: ${buffer.slice(0, 200)}`)), 10_000)
      socket.on("connect", () => socket.write(handshake))
      socket.on("data", (chunk) => {
        buffer += chunk.toString("latin1")
        if (!upgraded && buffer.includes("\r\n\r\n")) {
          const status = Number.parseInt(buffer.split(" ")[1], 10)
          if (status !== 101) {
            clearTimeout(timer)
            resolve({ status, accept: null, echoed: false })
            return
          }
          upgraded = true
          const acceptMatch = /sec-websocket-accept: (.+)\r\n/i.exec(buffer)
          buffer = ""
          socket.write("ping-through-gateway")
          setTimeout(() => {
            clearTimeout(timer)
            resolve({ status, accept: acceptMatch ? acceptMatch[1].trim() : null, echoed: buffer.includes("ping-through-gateway") })
          }, 500)
        }
      })
      socket.on("error", reject)
    })
    socket.destroy()

    assert.equal(result.status, 101)
    assert.equal(result.accept, expectedAccept)
    assert.ok(result.echoed, "bytes should round-trip through the piped sockets")
  })
})

test("websocket upgrade without a session is rejected", async () => {
  await withGateway(async (base, env) => {
    await env.sup.ensure("alice", "running")
    const port = Number.parseInt(new URL(base).port, 10)
    const socket = net.connect({ host: "127.0.0.1", port })
    const status = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000)
      socket.on("connect", () => {
        socket.write(
          ["GET /api/events.mux HTTP/1.1", "Host: computer.test", "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: AAAA", "", ""].join("\r\n"),
        )
      })
      socket.on("data", (chunk) => {
        clearTimeout(timer)
        resolve(Number.parseInt(chunk.toString("latin1").split(" ")[1], 10))
      })
      socket.on("error", reject)
    })
    socket.destroy()
    assert.equal(status, 403)
  })
})
