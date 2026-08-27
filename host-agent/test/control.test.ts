import assert from "node:assert/strict"
import { test } from "node:test"
import { Control } from "../src/control.ts"
import { listen, makeEnv, TEST_CONTROL_TOKEN, type TestEnv } from "./helpers.ts"

async function withControl(fn: (base: string, env: TestEnv) => Promise<void>): Promise<void> {
  const env = await makeEnv()
  const control = new Control(env.cfg, env.sup)
  const port = await listen(control.server)
  try {
    await fn(`http://127.0.0.1:${port}`, env)
  } finally {
    control.server.close()
    await env.cleanup()
  }
}

const AUTH = { authorization: `Bearer ${TEST_CONTROL_TOKEN}` }

test("control api requires the bearer token", async () => {
  await withControl(async (base) => {
    assert.equal((await fetch(`${base}/healthz`)).status, 401)
    assert.equal((await fetch(`${base}/healthz`, { headers: { authorization: "Bearer nope" } })).status, 401)
    assert.equal((await fetch(`${base}/healthz`, { headers: AUTH })).status, 200)
  })
})

test("instance lifecycle over the control api", async () => {
  await withControl(async (base, env) => {
    const missing = await fetch(`${base}/v1/instances/alice`, { headers: AUTH })
    assert.equal(missing.status, 404)

    const ensure = await fetch(`${base}/v1/instances/alice`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ desired: "running" }),
    })
    assert.equal(ensure.status, 200)
    const view = (await ensure.json()) as Record<string, unknown>
    assert.equal(view.status, "running")
    assert.equal(view.desired, "running")
    assert.ok(view.port)

    const list = await fetch(`${base}/v1/instances`, { headers: AUTH })
    const listBody = (await list.json()) as { instances: unknown[] }
    assert.equal(listBody.instances.length, 1)

    const health = await fetch(`${base}/healthz`, { headers: AUTH })
    const healthBody = (await health.json()) as { instances: { total: number; running: number } }
    assert.equal(healthBody.instances.total, 1)
    assert.equal(healthBody.instances.running, 1)

    const stop = await fetch(`${base}/v1/instances/alice`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ desired: "stopped" }),
    })
    assert.equal(((await stop.json()) as Record<string, unknown>).status, "stopped")

    const del = await fetch(`${base}/v1/instances/alice`, { method: "DELETE", headers: AUTH })
    assert.equal(del.status, 204)
    assert.equal((await fetch(`${base}/v1/instances/alice`, { headers: AUTH })).status, 404)
    assert.equal(env.sup.getView("alice"), undefined)
  })
})

test("invalid bodies and user ids are rejected", async () => {
  await withControl(async (base) => {
    const badDesired = await fetch(`${base}/v1/instances/alice`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ desired: "sideways" }),
    })
    assert.equal(badDesired.status, 400)

    const badJson = await fetch(`${base}/v1/instances/alice`, { method: "PUT", headers: AUTH, body: "{" })
    assert.equal(badJson.status, 400)

    const badUser = await fetch(`${base}/v1/instances/a%2Fb`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ desired: "stopped" }),
    })
    assert.equal(badUser.status, 404)

    const badEnv = await fetch(`${base}/v1/instances/alice`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ desired: "stopped", env: { "lower-case": "x" } }),
    })
    assert.equal(badEnv.status, 400)
  })
})

test("capacity limit surfaces as 507", async () => {
  const env = await makeEnv({ COMPUTER_MAX_INSTANCES: "1" })
  const control = new Control(env.cfg, env.sup)
  const port = await listen(control.server)
  const base = `http://127.0.0.1:${port}`
  try {
    await fetch(`${base}/v1/instances/only`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ desired: "stopped" }),
    })
    const overflow = await fetch(`${base}/v1/instances/second`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ desired: "stopped" }),
    })
    assert.equal(overflow.status, 507)
  } finally {
    control.server.close()
    await env.cleanup()
  }
})
