import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { CgroupManager } from "../src/cgroup.ts"
import { FACTORY_SETTINGS } from "../src/settings.ts"

async function fakeCgroupRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cgroup-"))
  await fsp.writeFile(path.join(root, "cgroup.controllers"), "cpuset cpu io memory pids\n")
  await fsp.writeFile(path.join(root, "cgroup.subtree_control"), "")
  await fsp.writeFile(path.join(root, "cgroup.procs"), `${process.pid}\n`)
  return root
}

test("open bootstraps agent/dsh trees and writes instance limits", async () => {
  const root = await fakeCgroupRoot()
  try {
    const manager = CgroupManager.open(root)
    assert.equal(manager.available, true)
    assert.equal(fs.readFileSync(path.join(root, "cgroup.subtree_control"), "utf8"), "+memory +pids")
    assert.ok(fs.existsSync(path.join(root, "agent")))
    assert.ok(fs.existsSync(path.join(root, "dsh")))

    const dir = manager.prepareInstance("user-a", FACTORY_SETTINGS)
    assert.equal(dir, path.join(root, "dsh", "user-a"))
    assert.equal(fs.readFileSync(path.join(dir!, "memory.max"), "utf8"), String(2048 * 1024 * 1024))
    assert.equal(fs.readFileSync(path.join(dir!, "memory.swap.max"), "utf8"), "0")
    assert.equal(fs.readFileSync(path.join(dir!, "memory.oom.group"), "utf8"), "1")
    assert.equal(fs.readFileSync(path.join(dir!, "pids.max"), "utf8"), "512")

    manager.applyLimits("user-a", { ...FACTORY_SETTINGS, instance_memory_max_mb: "max", instance_pids_max: "max" })
    assert.equal(fs.readFileSync(path.join(dir!, "memory.max"), "utf8"), "max")
    assert.equal(fs.readFileSync(path.join(dir!, "pids.max"), "utf8"), "max")

    fs.writeFileSync(path.join(dir!, "memory.events"), "low 0\noom_kill 2\n")
    assert.equal(manager.oomKills("user-a"), 2)
    manager.attach("user-a", 4242)
    assert.equal(fs.readFileSync(path.join(dir!, "cgroup.procs"), "utf8"), "4242\n")
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test("missing controllers degrade without throwing", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cgroup-empty-"))
  try {
    await fsp.writeFile(path.join(root, "cgroup.controllers"), "cpu\n")
    const manager = CgroupManager.open(root)
    assert.equal(manager.available, false)
    assert.equal(manager.prepareInstance("user-a", FACTORY_SETTINGS), undefined)
    manager.applyLimits("user-a", FACTORY_SETTINGS)
    manager.attach("user-a", 1)
    assert.equal(manager.oomKills("user-a"), 0)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})
