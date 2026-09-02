import * as fs from "node:fs"
import * as path from "node:path"
import { log } from "./log.ts"
import type { HostSettings, LimitValue } from "./settings.ts"

export const DEFAULT_CGROUP_ROOT = "/sys/fs/cgroup"
const AGENT_MIN_BYTES = 256 * 1024 * 1024
const AGENT_LOW_BYTES = 512 * 1024 * 1024

function limitToCgroup(value: LimitValue, unit: "bytes" | "count"): string {
  if (value === "max") return "max"
  if (unit === "bytes") return String(value * 1024 * 1024)
  return String(value)
}

function writeText(file: string, value: string): void {
  fs.writeFileSync(file, value)
}

export class CgroupManager {
  readonly available: boolean
  private readonly root: string

  private constructor(root: string, available: boolean) {
    this.root = root
    this.available = available
  }

  static unavailable(root = DEFAULT_CGROUP_ROOT): CgroupManager {
    return new CgroupManager(root, false)
  }

  static open(root = process.env.COMPUTER_CGROUP_ROOT || DEFAULT_CGROUP_ROOT): CgroupManager {
    try {
      const controllers = fs.readFileSync(path.join(root, "cgroup.controllers"), "utf8")
      if (!/\bmemory\b/.test(controllers) || !/\bpids\b/.test(controllers)) {
        log.warn("cgroup controllers missing memory/pids; per-instance limits disabled")
        return new CgroupManager(root, false)
      }
      const manager = new CgroupManager(root, true)
      manager.bootstrap()
      log.info("cgroup v2 ready for per-instance limits", { root })
      return manager
    } catch (err) {
      log.warn("cgroup unavailable; per-instance limits disabled", { err: String(err) })
      return new CgroupManager(root, false)
    }
  }

  private bootstrap(): void {
    const agent = path.join(this.root, "agent")
    fs.mkdirSync(agent, { recursive: true })
    const raw = fs.readFileSync(path.join(this.root, "cgroup.procs"), "utf8")
    for (const pid of raw.trim().split(/\s+/).filter(Boolean)) {
      try {
        writeText(path.join(agent, "cgroup.procs"), `${pid}\n`)
      } catch {
        // pid may have already exited
      }
    }
    writeText(path.join(this.root, "cgroup.subtree_control"), "+memory +pids")
    try {
      writeText(path.join(agent, "memory.min"), String(AGENT_MIN_BYTES))
      writeText(path.join(agent, "memory.low"), String(AGENT_LOW_BYTES))
    } catch (err) {
      log.warn("could not reserve memory for host-agent cgroup", { err: String(err) })
    }
    fs.mkdirSync(path.join(this.root, "dsh"), { recursive: true })
  }

  instanceDir(userId: string): string {
    return path.join(this.root, "dsh", userId)
  }

  prepareInstance(userId: string, settings: HostSettings): string | undefined {
    if (!this.available) return undefined
    try {
      const dir = this.instanceDir(userId)
      fs.mkdirSync(dir, { recursive: true })
      this.applyLimits(userId, settings)
      return dir
    } catch (err) {
      log.warn("cgroup prepare failed", { user: userId, err: String(err) })
      return undefined
    }
  }

  applyLimits(userId: string, settings: HostSettings): void {
    if (!this.available) return
    const dir = this.instanceDir(userId)
    if (!fs.existsSync(dir)) return
    try {
      writeText(path.join(dir, "memory.max"), limitToCgroup(settings.instance_memory_max_mb, "bytes"))
      writeText(path.join(dir, "memory.swap.max"), "0")
      writeText(path.join(dir, "memory.oom.group"), "1")
      writeText(path.join(dir, "pids.max"), limitToCgroup(settings.instance_pids_max, "count"))
    } catch (err) {
      log.warn("cgroup apply limits failed", { user: userId, err: String(err) })
    }
  }

  attach(userId: string, pid: number): void {
    if (!this.available) return
    try {
      writeText(path.join(this.instanceDir(userId), "cgroup.procs"), `${pid}\n`)
    } catch (err) {
      log.warn("cgroup attach failed", { user: userId, pid, err: String(err) })
    }
  }

  oomKills(userId: string): number {
    if (!this.available) return 0
    try {
      const text = fs.readFileSync(path.join(this.instanceDir(userId), "memory.events"), "utf8")
      const match = /^oom_kill\s+(\d+)/m.exec(text)
      return match ? Number.parseInt(match[1], 10) : 0
    } catch {
      return 0
    }
  }

  removeInstance(userId: string): void {
    if (!this.available) return
    try {
      fs.rmdirSync(this.instanceDir(userId))
    } catch {
      // still occupied or already gone
    }
  }
}
