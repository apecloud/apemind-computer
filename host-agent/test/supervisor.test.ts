import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { test } from "node:test"
import { CapacityError } from "../src/supervisor.ts"
import { makeEnv } from "./helpers.ts"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("ensure running starts dsh with the per-user environment", async () => {
  const env = await makeEnv()
  try {
    const view = await env.sup.ensure("alice", "running")
    assert.equal(view.status, "running")
    assert.ok(view.port)
    const probePath = path.join(env.cfg.dataDir, "users", "alice", ".apemind", "probe.json")
    const probe = JSON.parse(fs.readFileSync(probePath, "utf8"))
    assert.equal(probe.env.APEMIND_USER_ID, "alice")
    assert.ok(probe.env.DSH_HOME.endsWith("/.dsh"))

    const again = await env.sup.ensure("alice", "running")
    assert.equal(again.port, view.port)

    const stopped = await env.sup.ensure("alice", "stopped")
    assert.equal(stopped.status, "stopped")
    assert.equal(stopped.desired, "stopped")
  } finally {
    await env.cleanup()
  }
})

test("env with mcp settings renders the managed patch and passes --patch", async () => {
  const env = await makeEnv()
  try {
    await env.sup.ensure("bob", "running", {
      APEMIND_API_KEY: "sk-test-123",
      APEMIND_MCP_URL: "http://mcp.test/mcp",
    })
    const home = path.join(env.cfg.dataDir, "users", "bob")
    const patch = fs.readFileSync(path.join(home, ".apemind", "managed.cordis.yml"), "utf8")
    assert.match(patch, /dsh-mcp-client/)
    assert.match(patch, /http:\/\/mcp\.test\/mcp/)
    assert.doesNotMatch(patch, /sk-test-123/, "the key must stay out of the patch file")
    const probe = JSON.parse(fs.readFileSync(path.join(home, ".apemind", "probe.json"), "utf8"))
    assert.equal(probe.env.APEMIND_API_KEY, "sk-test-123")
    assert.ok(probe.argv.includes("--patch"))
  } finally {
    await env.cleanup()
  }
})

test("crashed instance restarts automatically while desired is running", async () => {
  const env = await makeEnv()
  try {
    const view = await env.sup.ensure("carol", "running")
    const inst = env.sup.get("carol")
    assert.ok(inst?.proc?.pid)
    process.kill(inst.proc.pid, "SIGKILL")
    let recovered = false
    for (let i = 0; i < 100; i += 1) {
      await sleep(200)
      const current = env.sup.getView("carol")
      if (current?.status === "running") {
        recovered = true
        break
      }
    }
    assert.ok(recovered, "instance should restart after a crash")
    assert.notEqual(env.sup.getView("carol")?.started_at, view.started_at)
  } finally {
    await env.cleanup()
  }
})

test("capacity limit rejects new instances", async () => {
  const env = await makeEnv({ COMPUTER_MAX_INSTANCES: "1" })
  try {
    await env.sup.ensure("dave", "stopped")
    await assert.rejects(() => env.sup.ensure("erin", "stopped"), CapacityError)
  } finally {
    await env.cleanup()
  }
})

test("remove wipes the workspace", async () => {
  const env = await makeEnv()
  try {
    await env.sup.ensure("frank", "running")
    const home = path.join(env.cfg.dataDir, "users", "frank")
    assert.ok(fs.existsSync(home))
    assert.equal(await env.sup.remove("frank"), true)
    assert.equal(fs.existsSync(home), false)
    assert.equal(await env.sup.remove("frank"), false)
  } finally {
    await env.cleanup()
  }
})

test("state survives a supervisor restart via meta.json", async () => {
  const env = await makeEnv()
  try {
    await env.sup.ensure("grace", "running")
    await env.sup.shutdown()

    const { Supervisor } = await import("../src/supervisor.ts")
    const sup2 = new Supervisor(env.cfg)
    await sup2.init()
    const view = sup2.getView("grace")
    assert.ok(view)
    assert.equal(view.status, "stopped")
    assert.equal(view.desired, "running")
    const woken = await sup2.wake("grace")
    assert.equal(woken?.status, "running")
    await sup2.shutdown()
  } finally {
    await env.cleanup()
  }
})
