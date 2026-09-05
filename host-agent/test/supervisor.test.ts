import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
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
    const homeMode = fs.statSync(path.join(env.cfg.dataDir, "users", "alice")).mode & 0o777
    assert.equal(homeMode, 0o700, "tenant home must not be world-readable")
    const probePath = path.join(env.cfg.dataDir, "users", "alice", ".apemind", "probe.json")
    const probe = JSON.parse(fs.readFileSync(probePath, "utf8"))
    assert.equal(probe.env.APEMIND_USER_ID, "alice")
    assert.equal(probe.env.APEMIND_INSTANCE_ID, "alice")
    assert.equal(probe.env.DSH_PERMISSION_MODE, "danger-full-access")
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
    assert.match(patch, /id: xmanrui-dsh-im/)
    assert.match(patch, /rpcAuthority: trusted-host/)
    assert.match(patch, /http:\/\/mcp\.test\/mcp/)
    assert.doesNotMatch(patch, /sk-test-123/, "the key must stay out of the patch file")
    const probe = JSON.parse(fs.readFileSync(path.join(home, ".apemind", "probe.json"), "utf8"))
    assert.equal(probe.env.APEMIND_API_KEY, "sk-test-123")
    assert.ok(probe.argv.includes("--patch"))
  } finally {
    await env.cleanup()
  }
})

test("env with llm projection renders the apemind provider row", async () => {
  const env = await makeEnv()
  try {
    await env.sup.ensure("hank", "running", {
      APEMIND_API_KEY: "sk-test-456",
      APEMIND_MCP_URL: "http://mcp.test/mcp",
      APEMIND_LLM_BASE_URL: "https://main.test/v1/llm",
      APEMIND_LLM_MODELS: JSON.stringify([
        { id: "model0123", name: "GPT X", context_window: 131072, vision: true },
        { id: "model0456", name: "O'Neil" },
      ]),
    })
    const home = path.join(env.cfg.dataDir, "users", "hank")
    const patch = fs.readFileSync(path.join(home, ".apemind", "managed.cordis.yml"), "utf8")
    assert.match(patch, /dsh-mcp-client/, "mcp row must stay alongside the provider row")
    assert.match(patch, /- id: llm-pi-ai/)
    assert.match(patch, /baseURL: 'https:\/\/main\.test\/v1\/llm'/)
    assert.match(patch, /apiKeyEnv: APEMIND_API_KEY/)
    assert.match(patch, /- id: 'model0123'/)
    assert.match(patch, /name: 'GPT X'/)
    assert.match(patch, /contextWindow: 131072/)
    assert.match(patch, /input: \[text, image\]/)
    assert.match(patch, /name: 'O''Neil'/, "single quotes must be yaml-escaped")
    assert.match(patch, /displayName: 'ApeMind'/)
    assert.doesNotMatch(patch, /displayName: 'GPT X'/)
    assert.doesNotMatch(patch, /id: agent-default-model/)
    assert.doesNotMatch(patch, /sk-test-456/, "the key must stay out of the patch file")
  } finally {
    await env.cleanup()
  }
})

test("default model id overrides agent-default-model when it is in the projection", async () => {
  const env = await makeEnv()
  try {
    await env.sup.ensure("opal", "stopped", {
      APEMIND_API_KEY: "sk-test-default",
      APEMIND_LLM_BASE_URL: "https://main.test/v1/llm",
      APEMIND_LLM_MODELS: JSON.stringify([
        { id: "model0123", name: "GPT X" },
        { id: "model0456", name: "Default Chat" },
      ]),
      APEMIND_LLM_DEFAULT_MODEL: "model0456",
    })
    const patch = fs.readFileSync(
      path.join(env.cfg.dataDir, "users", "opal", ".apemind", "managed.cordis.yml"),
      "utf8",
    )
    assert.match(patch, /- id: agent-default-model/)
    assert.match(patch, /provider: apemind/)
    assert.match(patch, /model: 'model0456'/)
    assert.equal(
      fs.existsSync(path.join(env.cfg.dataDir, "users", "opal", ".dsh", "settings.yaml")),
      false,
      "host must not write the user settings document",
    )
  } finally {
    await env.cleanup()
  }
})

test("unknown default model id does not override agent-default-model", async () => {
  const env = await makeEnv()
  try {
    await env.sup.ensure("pearl", "stopped", {
      APEMIND_API_KEY: "sk-test-missing",
      APEMIND_LLM_BASE_URL: "https://main.test/v1/llm",
      APEMIND_LLM_MODELS: JSON.stringify([{ id: "model0123", name: "GPT X" }]),
      APEMIND_LLM_DEFAULT_MODEL: "model-missing",
    })
    const patch = fs.readFileSync(
      path.join(env.cfg.dataDir, "users", "pearl", ".apemind", "managed.cordis.yml"),
      "utf8",
    )
    assert.doesNotMatch(patch, /id: agent-default-model/)
  } finally {
    await env.cleanup()
  }
})

test("full apemind env renders the workspace guide into DSH_HOME", async () => {
  const env = await makeEnv()
  try {
    await env.sup.ensure("lena", "running", {
      APEMIND_API_KEY: "sk-test-guide",
      APEMIND_BASE_URL: "https://main.test",
      APEMIND_ORG_ID: "org12345678",
      APEMIND_MCP_URL: "http://mcp.test/mcp",
      APEMIND_LLM_BASE_URL: "https://main.test/v1/llm",
      APEMIND_LLM_MODELS: JSON.stringify([{ id: "model0123", name: "GPT X" }]),
    })
    const guide = fs.readFileSync(
      path.join(env.cfg.dataDir, "users", "lena", ".dsh", "AGENTS.md"),
      "utf8",
    )
    assert.match(guide, /ApeMind Hosted Workspace/)
    assert.match(guide, /https:\/\/main\.test/)
    assert.match(guide, /org12345678/)
    assert.match(guide, /apemind skills/)
    assert.match(guide, /MCP server "apemind"/)
    assert.match(guide, /platform account role/)
    assert.match(guide, /Do not run `org role list`/)
    assert.doesNotMatch(guide, /sk-test-guide/, "the key must stay out of the guide")

    const statePath = path.join(
      env.cfg.dataDir,
      "users",
      "lena",
      ".config",
      "apemind",
      "profiles",
      "default",
      "state.json",
    )
    const profile = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      base_url: string
      api_key: string
      org_id?: string
      workspace_kind?: string
    }
    assert.equal(profile.base_url, "https://main.test")
    assert.equal(profile.api_key, "sk-test-guide")
    assert.equal(profile.org_id, "org12345678")
    assert.equal(profile.workspace_kind, "organization")
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600)
    const workspace = JSON.parse(
      fs.readFileSync(path.join(env.cfg.dataDir, "users", "lena", ".apemind", "workspace.json"), "utf8"),
    ) as { kind: string; org_id: string; instance_id: string }
    assert.equal(workspace.kind, "organization")
    assert.equal(workspace.org_id, "org12345678")
    assert.equal(workspace.instance_id, "lena")
    assert.doesNotMatch(
      fs.readFileSync(path.join(env.cfg.dataDir, "users", "lena", ".apemind", "workspace.json"), "utf8"),
      /sk-test-guide/,
    )
    const cfg = JSON.parse(
      fs.readFileSync(
        path.join(env.cfg.dataDir, "users", "lena", ".config", "apemind", "config.json"),
        "utf8",
      ),
    ) as { current_profile: string }
    assert.equal(cfg.current_profile, "default")
  } finally {
    await env.cleanup()
  }
})

test("CLI profile is rewritten when the bound key rotates", async () => {
  const env = await makeEnv()
  try {
    await env.sup.ensure("nina", "stopped", {
      APEMIND_API_KEY: "sk-old",
      APEMIND_BASE_URL: "https://main.test",
    })
    await env.sup.ensure("nina", "stopped", {
      APEMIND_API_KEY: "sk-new",
      APEMIND_BASE_URL: "https://main.test",
    })
    const profile = JSON.parse(
      fs.readFileSync(
        path.join(env.cfg.dataDir, "users", "nina", ".config", "apemind", "profiles", "default", "state.json"),
        "utf8",
      ),
    ) as { api_key: string }
    assert.equal(profile.api_key, "sk-new")
  } finally {
    await env.cleanup()
  }
})

test("guide without base url is absent and personal guide has no org line", async () => {
  const env = await makeEnv()
  try {
    await env.sup.ensure("mike", "stopped", {
      APEMIND_API_KEY: "sk-test-noguide",
      APEMIND_MCP_URL: "http://mcp.test/mcp",
    })
    const guidePath = path.join(env.cfg.dataDir, "users", "mike", ".dsh", "AGENTS.md")
    assert.equal(fs.existsSync(guidePath), false, "no guide without APEMIND_BASE_URL")
    assert.equal(
      fs.existsSync(path.join(env.cfg.dataDir, "users", "mike", ".config", "apemind")),
      false,
      "no CLI profile without APEMIND_BASE_URL",
    )

    await env.sup.ensure("mike", "stopped", {
      APEMIND_API_KEY: "sk-test-noguide",
      APEMIND_BASE_URL: "https://main.test",
    })
    const guide = fs.readFileSync(guidePath, "utf8")
    assert.doesNotMatch(guide, /Bound organization/)
    assert.match(guide, /personal workspace/)
    assert.match(guide, /Do not pass `--org-id`/)
    assert.doesNotMatch(guide, /MCP server/)
    const personalProfile = JSON.parse(
      fs.readFileSync(
        path.join(env.cfg.dataDir, "users", "mike", ".config", "apemind", "profiles", "default", "state.json"),
        "utf8",
      ),
    ) as { workspace_kind?: string; org_id?: string }
    assert.equal(personalProfile.workspace_kind, "personal")
    assert.equal(personalProfile.org_id, undefined)
  } finally {
    await env.cleanup()
  }
})

test("start rewrites a stale managed patch from env.json", async () => {
  const env = await makeEnv()
  try {
    await env.sup.ensure("kate", "stopped", {
      APEMIND_API_KEY: "sk-test-stale",
      APEMIND_LLM_BASE_URL: "https://main.test/v1/llm",
      APEMIND_LLM_MODELS: JSON.stringify([{ id: "model0123", name: "GPT X" }]),
    })
    const patchPath = path.join(env.cfg.dataDir, "users", "kate", ".apemind", "managed.cordis.yml")
    fs.writeFileSync(patchPath, "stale: true\n")
    await env.sup.ensure("kate", "running")
    const patch = fs.readFileSync(patchPath, "utf8")
    assert.match(patch, /name: 'GPT X'/)
    assert.doesNotMatch(patch, /stale/)
  } finally {
    await env.cleanup()
  }
})

test("llm projection without models keeps the provider row out of the patch", async () => {
  const env = await makeEnv()
  try {
    await env.sup.ensure("iris", "running", {
      APEMIND_API_KEY: "sk-test-789",
      APEMIND_LLM_BASE_URL: "https://main.test/v1/llm",
      APEMIND_LLM_MODELS: "[]",
    })
    const home = path.join(env.cfg.dataDir, "users", "iris")
    const patch = fs.readFileSync(path.join(home, ".apemind", "managed.cordis.yml"), "utf8")
    assert.match(patch, /id: xmanrui-dsh-im/)
    assert.doesNotMatch(patch, /llm-pi-ai/)
    assert.doesNotMatch(patch, /dsh-mcp-client/)
  } finally {
    await env.cleanup()
  }
})

test("malformed llm model projection is rejected before anything is written", async () => {
  const env = await makeEnv()
  try {
    await assert.rejects(
      () =>
        env.sup.ensure("judy", "stopped", {
          APEMIND_API_KEY: "sk-test-000",
          APEMIND_LLM_BASE_URL: "https://main.test/v1/llm",
          APEMIND_LLM_MODELS: "not-json",
        }),
      /invalid env entry: APEMIND_LLM_MODELS/,
    )
    const home = path.join(env.cfg.dataDir, "users", "judy")
    assert.equal(fs.existsSync(path.join(home, ".apemind", "env.json")), false)
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
  const env = await makeEnv({}, { max_instances: 1 })
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
    await env.sup.revokeSessions("grace")
    await env.sup.shutdown()

    const { Supervisor } = await import("../src/supervisor.ts")
    const { loadHostSettings } = await import("../src/settings.ts")
    const { CgroupManager } = await import("../src/cgroup.ts")
    const sup2 = new Supervisor(env.cfg, loadHostSettings(env.cfg.dataDir), CgroupManager.unavailable())
    await sup2.init()
    const view = sup2.getView("grace")
    assert.ok(view)
    assert.equal(view.status, "stopped")
    assert.equal(view.desired, "running")
    assert.equal(sup2.sessionGeneration("grace"), 1, "session generation must survive restarts")
    assert.equal(view.last_activity, undefined, "init must not invent last_activity")
    await sup2.resumeKeptInstances()
    assert.equal(sup2.getView("grace")?.status, "stopped", "no lastTrafficAt means do not resume")
    const woken = await sup2.wake("grace")
    assert.equal(woken?.status, "running")
    await sup2.shutdown()
  } finally {
    await env.cleanup()
  }
})

async function restartSupervisor(env: Awaited<ReturnType<typeof makeEnv>>) {
  await env.sup.shutdown()
  const { Supervisor } = await import("../src/supervisor.ts")
  const { loadHostSettings } = await import("../src/settings.ts")
  const { CgroupManager } = await import("../src/cgroup.ts")
  const sup = new Supervisor(env.cfg, loadHostSettings(env.cfg.dataDir), CgroupManager.unavailable())
  await sup.init()
  return sup
}

test("touch persists lastTrafficAt and resume follows the idle policy", async () => {
  const env = await makeEnv()
  try {
    await env.sup.ensure("nova", "running")
    env.sup.touch("nova")
    await sleep(50)
    const metaPath = path.join(env.cfg.dataDir, "users", "nova", ".apemind", "meta.json")
    const written = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { lastTrafficAt?: string }
    assert.ok(written.lastTrafficAt)

    const sup2 = await restartSupervisor(env)
    const loaded = sup2.getView("nova")
    assert.equal(loaded?.status, "stopped")
    assert.equal(loaded?.desired, "running")
    assert.equal(loaded?.last_activity, written.lastTrafficAt)
    await sup2.resumeKeptInstances()
    assert.equal(sup2.getView("nova")?.status, "running")
    await sup2.shutdown()
  } finally {
    await env.cleanup()
  }
})

test("resume skips user-stopped instances even with recent traffic", async () => {
  const env = await makeEnv()
  try {
    await env.sup.ensure("orin", "running")
    env.sup.touch("orin")
    await sleep(50)
    await env.sup.ensure("orin", "stopped")
    const sup2 = await restartSupervisor(env)
    await sup2.resumeKeptInstances()
    const view = sup2.getView("orin")
    assert.equal(view?.desired, "stopped")
    assert.equal(view?.status, "stopped")
    await sup2.shutdown()
  } finally {
    await env.cleanup()
  }
})

test("resume skips instances whose traffic is outside the idle window", async () => {
  const env = await makeEnv({}, { idle_timeout_sec: 1 })
  try {
    await env.sup.ensure("pax", "running")
    env.sup.touch("pax")
    await sleep(50)
    const metaPath = path.join(env.cfg.dataDir, "users", "pax", ".apemind", "meta.json")
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { lastTrafficAt?: string }
    meta.lastTrafficAt = new Date(Date.now() - 60_000).toISOString()
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
    const sup2 = await restartSupervisor(env)
    assert.ok(sup2.getView("pax")?.last_activity)
    await sup2.resumeKeptInstances()
    assert.equal(sup2.getView("pax")?.status, "stopped")
    await sup2.shutdown()
  } finally {
    await env.cleanup()
  }
})

test("idle_timeout 0 resumes any desired-running instance that has lastTrafficAt", async () => {
  const env = await makeEnv({}, { idle_timeout_sec: 0 })
  try {
    await env.sup.ensure("quinn", "running")
    env.sup.touch("quinn")
    await sleep(50)
    const metaPath = path.join(env.cfg.dataDir, "users", "quinn", ".apemind", "meta.json")
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { lastTrafficAt?: string }
    meta.lastTrafficAt = new Date(Date.now() - 60_000).toISOString()
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
    const sup2 = await restartSupervisor(env)
    await sup2.resumeKeptInstances()
    assert.equal(sup2.getView("quinn")?.status, "running")
    await sup2.shutdown()
  } finally {
    await env.cleanup()
  }
})

test("start copies the baked default plugins into the tenant web profile", async () => {
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-im-host-seed-"))
  try {
    const seedWeb = path.join(seed, "profiles", "web")
    fs.mkdirSync(path.join(seedWeb, "node_modules", "@xmanrui", "dsh-im"), { recursive: true })
    fs.mkdirSync(path.join(seedWeb, "node_modules", "@michengai", "dsh-automation"), { recursive: true })
    fs.writeFileSync(path.join(seedWeb, "node_modules", "@xmanrui", "dsh-im", "index.js"), "ok\n")
    fs.writeFileSync(path.join(seedWeb, "node_modules", "@michengai", "dsh-automation", "index.js"), "auto\n")
    fs.writeFileSync(
      path.join(seedWeb, "package.json"),
      `${JSON.stringify({
        name: "dsh-profile-web",
        dependencies: { "@xmanrui/dsh-im": "4.8.0", "@michengai/dsh-automation": "0.1.25" },
      }, null, 2)}\n`,
    )
    const env = await makeEnv({ COMPUTER_DSH_IM_SEED: seed })
    try {
      await env.sup.ensure("mina", "running")
      const pkgPath = path.join(env.cfg.dataDir, "users", "mina", ".dsh", "profiles", "web", "package.json")
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
      assert.equal(pkg.dependencies["@xmanrui/dsh-im"], "4.8.0")
      assert.equal(pkg.dependencies["@michengai/dsh-automation"], "0.1.25")
      assert.ok(pkg.dsh.profile.bundles.includes("@xmanrui/dsh-im"))
      assert.ok(pkg.dsh.profile.bundles.includes("@michengai/dsh-automation"))
      const webNm = path.join(env.cfg.dataDir, "users", "mina", ".dsh", "profiles", "web", "node_modules")
      assert.equal(fs.readFileSync(path.join(webNm, "@xmanrui", "dsh-im", "index.js"), "utf8"), "ok\n")
      assert.equal(fs.readFileSync(path.join(webNm, "@michengai", "dsh-automation", "index.js"), "utf8"), "auto\n")
    } finally {
      await env.cleanup()
    }
  } finally {
    fs.rmSync(seed, { recursive: true, force: true })
  }
})
