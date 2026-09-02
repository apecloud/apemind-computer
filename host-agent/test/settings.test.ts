import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { Control } from "../src/control.ts"
import {
  FACTORY_SETTINGS,
  loadHostSettings,
  SETTINGS_KEYS,
  SettingsError,
} from "../src/settings.ts"
import { listen, makeEnv, TEST_CONTROL_TOKEN } from "./helpers.ts"

const FACTORY_FILE = fileURLToPath(new URL("../settings.factory.json", import.meta.url))
const AUTH = { authorization: `Bearer ${TEST_CONTROL_TOKEN}` }

async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "computer-settings-"))
}

test("factory JSON matches in-code factory settings", () => {
  const file = JSON.parse(fs.readFileSync(FACTORY_FILE, "utf8")) as Record<string, unknown>
  assert.deepEqual(file, FACTORY_SETTINGS)
  assert.deepEqual(Object.keys(file).sort(), [...SETTINGS_KEYS].sort())
})

test("missing data-dir file is replaced with a complete factory copy", async () => {
  const dir = await tmpDir()
  try {
    const store = loadHostSettings(dir, FACTORY_FILE)
    assert.deepEqual(store.snapshot(), FACTORY_SETTINGS)
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"))
    assert.deepEqual(onDisk, FACTORY_SETTINGS)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("missing keys are filled from factory and written back", async () => {
  const dir = await tmpDir()
  try {
    const file = path.join(dir, "settings.json")
    fs.writeFileSync(file, `${JSON.stringify({ idle_timeout_sec: 60, leftover: true }, null, 2)}\n`)
    const store = loadHostSettings(dir, FACTORY_FILE)
    assert.equal(store.snapshot().idle_timeout_sec, 60)
    assert.equal(store.snapshot().session_ttl_sec, FACTORY_SETTINGS.session_ttl_sec)
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    assert.equal(onDisk.leftover, undefined)
    assert.deepEqual(Object.keys(onDisk).sort(), [...SETTINGS_KEYS].sort())
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("corrupt or out-of-range files are replaced with factory settings", async () => {
  const dir = await tmpDir()
  try {
    const file = path.join(dir, "settings.json")
    fs.writeFileSync(file, "not-json")
    assert.deepEqual(loadHostSettings(dir, FACTORY_FILE).snapshot(), FACTORY_SETTINGS)

    fs.writeFileSync(file, `${JSON.stringify({ idle_timeout_sec: -1 }, null, 2)}\n`)
    assert.deepEqual(loadHostSettings(dir, FACTORY_FILE).snapshot(), FACTORY_SETTINGS)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("deleted idle env does not change the file value", async () => {
  const dir = await tmpDir()
  try {
    const store = loadHostSettings(dir, FACTORY_FILE)
    assert.equal(store.snapshot().idle_timeout_sec, 1800)
    const env = await makeEnv({ COMPUTER_IDLE_TIMEOUT_SEC: "60" })
    try {
      assert.equal(env.settings.snapshot().idle_timeout_sec, 1800)
    } finally {
      await env.cleanup()
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("paired runtime GET includes complete settings; unpaired GET does not", async () => {
  const unpaired = await makeEnv({ COMPUTER_TICKET_SECRET: "", COMPUTER_CONTROL_TOKEN: "" })
  const unpairedControl = new Control(unpaired.cfg, unpaired.identity, unpaired.sup)
  const unpairedPort = await listen(unpairedControl.server)
  try {
    const view = (await (await fetch(`http://127.0.0.1:${unpairedPort}/v1/runtime`)).json()) as Record<string, unknown>
    assert.equal(view.state, "unpaired")
    assert.equal(view.settings, undefined)
  } finally {
    unpairedControl.server.close()
    await unpaired.cleanup()
  }

  const env = await makeEnv()
  const control = new Control(env.cfg, env.identity, env.sup)
  const port = await listen(control.server)
  try {
    const view = (await (
      await fetch(`http://127.0.0.1:${port}/v1/runtime`, { headers: AUTH })
    ).json()) as Record<string, unknown>
    assert.equal(view.state, "paired")
    assert.deepEqual(view.settings, env.settings.snapshot())
  } finally {
    control.server.close()
    await env.cleanup()
  }
})

test("PUT settings patches, null resets to factory, unknown and out of range stay 400", async () => {
  const env = await makeEnv()
  const control = new Control(env.cfg, env.identity, env.sup)
  const port = await listen(control.server)
  const base = `http://127.0.0.1:${port}`
  const headers = { ...AUTH, "content-type": "application/json" }
  try {
    const ok = await fetch(`${base}/v1/runtime`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ settings: { idle_timeout_sec: 60, session_ttl_sec: null } }),
    })
    assert.equal(ok.status, 200)
    const body = (await ok.json()) as { settings: Record<string, number> }
    assert.equal(body.settings.idle_timeout_sec, 60)
    assert.equal(body.settings.session_ttl_sec, FACTORY_SETTINGS.session_ttl_sec)
    assert.deepEqual(Object.keys(body.settings).sort(), [...SETTINGS_KEYS].sort())
    const onDisk = JSON.parse(fs.readFileSync(path.join(env.cfg.dataDir, "settings.json"), "utf8"))
    assert.deepEqual(onDisk, body.settings)

    const unknown = await fetch(`${base}/v1/runtime`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ settings: { idle_timeout_sec: 90, extra: 1 } }),
    })
    assert.equal(unknown.status, 400)
    assert.equal(env.settings.snapshot().idle_timeout_sec, 60)

    const outOfRange = await fetch(`${base}/v1/runtime`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ settings: { idle_timeout_sec: 86401 } }),
    })
    assert.equal(outOfRange.status, 400)
    assert.match(((await outOfRange.json()) as { error: string }).error, /out of range/)
    assert.equal(env.settings.snapshot().idle_timeout_sec, 60)

    const reset = await fetch(`${base}/v1/runtime`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ settings: { idle_timeout_sec: null } }),
    })
    assert.equal(reset.status, 200)
    assert.equal(((await reset.json()) as { settings: { idle_timeout_sec: number } }).settings.idle_timeout_sec, 1800)
  } finally {
    control.server.close()
    await env.cleanup()
  }
})

test("preshared mode can PUT settings while main_url stays 409", async () => {
  const env = await makeEnv()
  const control = new Control(env.cfg, env.identity, env.sup)
  const port = await listen(control.server)
  const base = `http://127.0.0.1:${port}`
  const headers = { ...AUTH, "content-type": "application/json" }
  try {
    const settingsOnly = await fetch(`${base}/v1/runtime`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ settings: { idle_timeout_sec: 120 } }),
    })
    assert.equal(settingsOnly.status, 200)
    assert.equal(env.settings.snapshot().idle_timeout_sec, 120)

    const both = await fetch(`${base}/v1/runtime`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ main_url: "http://moved.test", settings: { max_instances: 3 } }),
    })
    assert.equal(both.status, 409)
    assert.equal(env.settings.snapshot().max_instances, 3)
  } finally {
    control.server.close()
    await env.cleanup()
  }
})

test("idle sweep uses the live settings value", async () => {
  const env = await makeEnv()
  try {
    await env.sup.ensure("idle-user", "running")
    const inst = env.sup.get("idle-user")
    assert.ok(inst)
    inst.lastActivity = new Date(Date.now() - 5_000)
    env.sup.sweepIdle()
    assert.equal(env.sup.getView("idle-user")?.status, "running")

    env.settings.applyPatch({ idle_timeout_sec: 1 })
    inst.lastActivity = new Date(Date.now() - 5_000)
    env.sup.sweepIdle()
    for (let i = 0; i < 40; i += 1) {
      if (env.sup.getView("idle-user")?.status === "stopped") break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const view = env.sup.getView("idle-user")
    assert.equal(view?.status, "stopped")
    assert.equal(view?.desired, "running")

    env.settings.applyPatch({ idle_timeout_sec: 0 })
    await env.sup.ensure("idle-user", "running")
    const again = env.sup.get("idle-user")
    assert.ok(again)
    again.lastActivity = new Date(Date.now() - 60_000)
    env.sup.sweepIdle()
    assert.equal(env.sup.getView("idle-user")?.status, "running")
  } finally {
    await env.cleanup()
  }
})

test("PUT settings leaves host.json pairing bytes unchanged", async () => {
  const env = await makeEnv({ COMPUTER_TICKET_SECRET: "", COMPUTER_CONTROL_TOKEN: "" })
  const control = new Control(env.cfg, env.identity, env.sup)
  const port = await listen(control.server)
  const base = `http://127.0.0.1:${port}`
  try {
    const paired = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ main_url: "http://paired-main.test" }),
    })
    const secrets = (await paired.json()) as { control_token: string }
    const hostFile = path.join(env.cfg.dataDir, "host.json")
    const before = fs.readFileSync(hostFile)
    const headers = { authorization: `Bearer ${secrets.control_token}`, "content-type": "application/json" }
    for (const idle of [60, 90, 1800]) {
      const res = await fetch(`${base}/v1/runtime`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ settings: { idle_timeout_sec: idle } }),
      })
      assert.equal(res.status, 200)
    }
    assert.deepEqual(fs.readFileSync(hostFile), before)
  } finally {
    control.server.close()
    await env.cleanup()
  }
})

test("limit settings accept max and reject zero", async () => {
  const dir = await tmpDir()
  try {
    const store = loadHostSettings(dir, FACTORY_FILE)
    store.applyPatch({ instance_memory_max_mb: "max", instance_pids_max: 1024 })
    assert.equal(store.snapshot().instance_memory_max_mb, "max")
    assert.equal(store.snapshot().instance_pids_max, 1024)
    assert.throws(() => store.applyPatch({ instance_memory_max_mb: 0 }), /out of range/)
    assert.throws(() => store.applyPatch({ instance_pids_max: 0 }), /out of range/)
    assert.throws(() => store.applyPatch({ instance_memory_max_mb: "unlimited" }), SettingsError)
    store.applyPatch({ instance_memory_max_mb: null })
    assert.equal(store.snapshot().instance_memory_max_mb, FACTORY_SETTINGS.instance_memory_max_mb)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("applyPatch rejects unknown keys without writing", async () => {
  const dir = await tmpDir()
  try {
    const store = loadHostSettings(dir, FACTORY_FILE)
    assert.throws(() => store.applyPatch({ nope: 1 }), SettingsError)
    assert.deepEqual(store.snapshot(), FACTORY_SETTINGS)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
