import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as net from "node:net"
import * as path from "node:path"
import type { Config } from "./config.ts"
import { log } from "./log.ts"
import { USER_ID_RE } from "./ticket.ts"

export type InstanceStatus = "stopped" | "starting" | "running" | "error"
export type Desired = "running" | "stopped"

interface InstanceMeta {
  desired: Desired
  createdAt: string
  uid?: number
  /** Bumped by revokeSessions; gateway sessions minted for an older value
   * stop verifying, so a control-plane revoke kicks every live cookie. */
  sessionGeneration?: number
}

interface Instance {
  userId: string
  meta: InstanceMeta
  status: InstanceStatus
  port?: number
  proc?: ChildProcess
  startedAt?: Date
  lastActivity: Date
  consecutiveFailures: number
  error?: string
  stopping: boolean
  startingPromise?: Promise<void>
  restartTimer?: NodeJS.Timeout
}

export interface InstanceView {
  user_id: string
  status: InstanceStatus
  desired: Desired
  port?: number
  started_at?: string
  last_activity?: string
  rss_bytes?: number
  error?: string
}

export class CapacityError extends Error {}
export class StartError extends Error {}

const MAX_CONSECUTIVE_FAILURES = 5
const READY_PROBE_INTERVAL_MS = 300

function readRssBytes(pid: number): number | undefined {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8")
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status)
    if (match) return Number.parseInt(match[1], 10) * 1024
  } catch {
    return undefined
  }
  return undefined
}

async function chownTree(root: string, uid: number, gid: number): Promise<void> {
  await fsp.chown(root, uid, gid)
  const entries = await fsp.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const child = path.join(root, entry.name)
    if (entry.isDirectory()) await chownTree(child, uid, gid)
    else await fsp.chown(child, uid, gid)
  }
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fsp.chmod(file, 0o600)
}

function yamlSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

interface ManagedModel {
  id: string
  name?: string
  contextWindow?: number
  vision?: boolean
}

/** Parse the APEMIND_LLM_MODELS JSON contract. The error message must start
 * with "invalid" so the control API maps a malformed projection to HTTP 400. */
function parseManagedModels(raw: string): ManagedModel[] {
  const fail = (): never => {
    throw new Error("invalid env entry: APEMIND_LLM_MODELS")
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return fail()
  }
  if (!Array.isArray(data)) return fail()
  const models: ManagedModel[] = []
  for (const item of data) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return fail()
    const record = item as Record<string, unknown>
    if (typeof record.id !== "string" || record.id.length === 0) return fail()
    const model: ManagedModel = { id: record.id }
    if (typeof record.name === "string" && record.name) model.name = record.name
    if (typeof record.context_window === "number" && Number.isFinite(record.context_window) && record.context_window > 0) {
      model.contextWindow = Math.floor(record.context_window)
    }
    if (record.vision === true) model.vision = true
    models.push(model)
  }
  return models
}

function renderModelProviderLines(baseUrl: string, models: ManagedModel[]): string[] {
  const lines = [
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    "      apemind:",
    "        displayName: 'ApeMind'",
    "        api: openai-completions",
    `        baseURL: ${yamlSingleQuote(baseUrl)}`,
    "        apiKeyEnv: APEMIND_API_KEY",
    "        models:",
  ]
  for (const model of models) {
    lines.push(`          - id: ${yamlSingleQuote(model.id)}`)
    if (model.name) lines.push(`            name: ${yamlSingleQuote(model.name)}`)
    if (model.contextWindow !== undefined) lines.push(`            contextWindow: ${model.contextWindow}`)
    if (model.vision) lines.push("            input: [text, image]")
  }
  return lines
}

/** Managed cordis patch: ApeMind MCP tools plus the projected model provider.
 * Secrets stay in the process env; the patch only carries env var names. */
function renderManagedPatch(env: Record<string, string>): string | undefined {
  const sections: string[] = []
  if (env.APEMIND_MCP_URL && env.APEMIND_API_KEY) {
    sections.push(
      "- insert:",
      "    - id: mcp-apemind",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        serverName: apemind",
      "        transport: streamable-http",
      `        url: ${yamlSingleQuote(env.APEMIND_MCP_URL)}`,
      "        headers:",
      "          Authorization: !!js '`Bearer ${process.env.APEMIND_API_KEY}`'",
    )
  }
  if (env.APEMIND_LLM_BASE_URL && env.APEMIND_API_KEY) {
    const models = parseManagedModels(env.APEMIND_LLM_MODELS ?? "[]")
    if (models.length > 0) {
      sections.push(...renderModelProviderLines(env.APEMIND_LLM_BASE_URL, models))
    }
  }
  if (sections.length === 0) return undefined
  return `${sections.join("\n")}\n`
}

/** Managed workspace guide, loaded by dsh from $DSH_HOME/AGENTS.md. Tells the
 * agent which identity this instance is bound to and which ApeMind channels
 * exist. Derived from env.json before every spawn (managed file: manual edits
 * do not survive a restart). Only env var names and ids appear here. */
function renderAgentsGuide(env: Record<string, string>): string | undefined {
  if (!env.APEMIND_API_KEY || !env.APEMIND_BASE_URL) return undefined
  const lines = [
    "# ApeMind Hosted Workspace",
    "",
    "This dsh instance is managed by ApeMind and bound to one ApeMind identity.",
    `- ApeMind API base URL: ${env.APEMIND_BASE_URL}.`,
    "- The `apemind` CLI is preinstalled and pre-authenticated (local profile under `$XDG_CONFIG_HOME/apemind`). Run `apemind skills` for full usage and `apemind whoami` for the bound identity. Do not print credentials.",
  ]
  if (env.APEMIND_ORG_ID) {
    lines.push(`- Bound organization: ${env.APEMIND_ORG_ID}. Org-scoped CLI commands (collection, document, bot, org) default to it.`)
  }
  if (env.APEMIND_MCP_URL) {
    lines.push('- The MCP server "apemind" provides knowledge search/read tools; prefer it for retrieval and use the CLI for everything else (creating collections, uploading documents, bots, chats).')
  }
  if (env.APEMIND_LLM_MODELS && env.APEMIND_LLM_MODELS !== "[]") {
    lines.push('- The model picker\'s "ApeMind" provider serves this workspace\'s ApeMind models.')
  }
  return `${lines.join("\n")}\n`
}

export class Supervisor {
  private readonly cfg: Config
  private readonly instances = new Map<string, Instance>()
  private readonly reservedPorts = new Set<number>()
  private sweepTimer?: NodeJS.Timeout
  private shuttingDown = false

  constructor(cfg: Config) {
    this.cfg = cfg
  }

  private usersDir(): string {
    return path.join(this.cfg.dataDir, "users")
  }

  private homeDir(userId: string): string {
    return path.join(this.usersDir(), userId)
  }

  private metaPath(userId: string): string {
    return path.join(this.homeDir(userId), ".apemind", "meta.json")
  }

  private envPath(userId: string): string {
    return path.join(this.homeDir(userId), ".apemind", "env.json")
  }

  private patchPath(userId: string): string {
    return path.join(this.homeDir(userId), ".apemind", "managed.cordis.yml")
  }

  private guidePath(userId: string): string {
    return path.join(this.homeDir(userId), ".dsh", "AGENTS.md")
  }

  /** Per-instance CLI state root. Spawn sets XDG_CONFIG_HOME to $HOME/.config,
   * so this is where `apemind` looks when the bash tool env has been scrubbed. */
  private cliConfigDir(userId: string): string {
    return path.join(this.homeDir(userId), ".config", "apemind")
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.usersDir(), { recursive: true })
    const entries = await fsp.readdir(this.usersDir(), { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !USER_ID_RE.test(entry.name)) continue
      try {
        const meta = JSON.parse(await fsp.readFile(this.metaPath(entry.name), "utf8")) as InstanceMeta
        this.instances.set(entry.name, {
          userId: entry.name,
          meta,
          status: "stopped",
          lastActivity: new Date(),
          consecutiveFailures: 0,
          stopping: false,
        })
      } catch {
        log.warn("skip user dir without readable meta", { user: entry.name })
      }
    }
    this.sweepTimer = setInterval(() => this.idleSweep(), 60_000)
    this.sweepTimer.unref()
    log.info("supervisor initialized", { instances: this.instances.size })
  }

  list(): InstanceView[] {
    return [...this.instances.values()].map((inst) => this.view(inst))
  }

  get(userId: string): Instance | undefined {
    return this.instances.get(userId)
  }

  getView(userId: string): InstanceView | undefined {
    const inst = this.instances.get(userId)
    return inst ? this.view(inst) : undefined
  }

  view(inst: Instance): InstanceView {
    return {
      user_id: inst.userId,
      status: inst.status,
      desired: inst.meta.desired,
      port: inst.status === "running" || inst.status === "starting" ? inst.port : undefined,
      started_at: inst.startedAt?.toISOString(),
      last_activity: inst.lastActivity.toISOString(),
      rss_bytes: inst.proc?.pid !== undefined ? readRssBytes(inst.proc.pid) : undefined,
      error: inst.status === "error" ? inst.error : undefined,
    }
  }

  touch(userId: string): void {
    const inst = this.instances.get(userId)
    if (inst) inst.lastActivity = new Date()
  }

  sessionGeneration(userId: string): number {
    return this.instances.get(userId)?.meta.sessionGeneration ?? 0
  }

  /** Invalidate every outstanding gateway session for one instance. */
  async revokeSessions(userId: string): Promise<InstanceView | undefined> {
    const inst = this.instances.get(userId)
    if (!inst) return undefined
    inst.meta.sessionGeneration = (inst.meta.sessionGeneration ?? 0) + 1
    await this.persistMeta(inst)
    log.info("sessions revoked", { user: userId, generation: inst.meta.sessionGeneration })
    return this.view(inst)
  }

  async ensure(userId: string, desired: Desired, env?: Record<string, string>): Promise<InstanceView> {
    if (!USER_ID_RE.test(userId)) throw new Error("invalid user_id")
    let inst = this.instances.get(userId)
    if (!inst) {
      if (this.instances.size >= this.cfg.maxInstances) throw new CapacityError("max instances reached")
      inst = await this.createInstance(userId)
    }
    if (env) await this.writeInstanceEnv(inst, env)
    if (inst.meta.desired !== desired) {
      inst.meta.desired = desired
      await this.persistMeta(inst)
    }
    if (desired === "running") {
      inst.consecutiveFailures = 0
      await this.start(inst)
    } else {
      await this.stopProcess(inst)
    }
    return this.view(inst)
  }

  /** Restart a stopped-but-desired-running instance; used by the gateway on first touch. */
  async wake(userId: string): Promise<Instance | undefined> {
    const inst = this.instances.get(userId)
    if (!inst || inst.meta.desired !== "running") return inst
    if (inst.status === "running") return inst
    inst.consecutiveFailures = 0
    await this.start(inst)
    return inst
  }

  async remove(userId: string): Promise<boolean> {
    const inst = this.instances.get(userId)
    if (!inst) return false
    if (inst.restartTimer) clearTimeout(inst.restartTimer)
    await this.stopProcess(inst)
    await this.removeLoopbackRules(inst)
    this.instances.delete(userId)
    await fsp.rm(this.homeDir(userId), { recursive: true, force: true })
    log.info("instance removed", { user: userId })
    return true
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    await Promise.all([...this.instances.values()].map((inst) => this.stopProcess(inst)))
  }

  counts(): { total: number; running: number } {
    let running = 0
    for (const inst of this.instances.values()) if (inst.status === "running") running += 1
    return { total: this.instances.size, running }
  }

  private async createInstance(userId: string): Promise<Instance> {
    const home = this.homeDir(userId)
    for (const dir of ["", "workspace", ".dsh", ".apemind", ".config", ".cache", path.join(".local", "share")]) {
      await fsp.mkdir(path.join(home, dir), { recursive: true })
    }
    // block cross-tenant traversal regardless of uid isolation being on
    await fsp.chmod(home, 0o700)
    const meta: InstanceMeta = { desired: "stopped", createdAt: new Date().toISOString() }
    if (this.cfg.uidBase > 0) {
      meta.uid = this.allocateUid()
    }
    const inst: Instance = {
      userId,
      meta,
      status: "stopped",
      lastActivity: new Date(),
      consecutiveFailures: 0,
      stopping: false,
    }
    this.instances.set(userId, inst)
    await this.persistMeta(inst)
    if (meta.uid !== undefined) await chownTree(home, meta.uid, meta.uid)
    log.info("instance created", { user: userId, uid: meta.uid })
    return inst
  }

  private statusOf(inst: Instance): InstanceStatus {
    return inst.status
  }

  private allocateUid(): number {
    let uid = this.cfg.uidBase
    const used = new Set<number>()
    for (const inst of this.instances.values()) {
      if (inst.meta.uid !== undefined) used.add(inst.meta.uid)
    }
    while (used.has(uid)) uid += 1
    return uid
  }

  private async persistMeta(inst: Instance): Promise<void> {
    const target = this.metaPath(inst.userId)
    await fsp.writeFile(target, `${JSON.stringify(inst.meta, null, 2)}\n`, { mode: 0o600 })
  }

  private async writeInstanceEnv(inst: Instance, env: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(env)) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || typeof value !== "string") {
        throw new Error(`invalid env entry: ${key}`)
      }
    }
    renderManagedPatch(env)
    await fsp.writeFile(this.envPath(inst.userId), `${JSON.stringify(env, null, 2)}\n`, { mode: 0o600 })
    await this.syncManagedFiles(inst, env)
    if (inst.meta.uid !== undefined) {
      await chownTree(path.join(this.homeDir(inst.userId), ".apemind"), inst.meta.uid, inst.meta.uid)
    }
  }

  /** Patch yaml, workspace guide, and CLI profile are derived from env.json;
   * rewrite them whenever the env changes or we are about to spawn. */
  private async syncManagedFiles(inst: Instance, env: Record<string, string>): Promise<void> {
    const patch = renderManagedPatch(env)
    if (patch !== undefined) {
      await fsp.writeFile(this.patchPath(inst.userId), patch, { mode: 0o600 })
    } else {
      await fsp.rm(this.patchPath(inst.userId), { force: true })
    }
    const guide = renderAgentsGuide(env)
    if (guide !== undefined) {
      await fsp.writeFile(this.guidePath(inst.userId), guide, { mode: 0o600 })
      if (inst.meta.uid !== undefined) {
        await fsp.chown(this.guidePath(inst.userId), inst.meta.uid, inst.meta.uid)
      }
    } else {
      await fsp.rm(this.guidePath(inst.userId), { force: true })
    }
    await this.syncCliProfile(inst, env)
  }

  /** dsh's bash/tool children are spawned from scrubbedParentEnv(), which drops
   * any name matching /KEY|PASSWORD|SECRET|TOKEN/i. APEMIND_API_KEY therefore
   * stays in the dsh Node process (MCP + LLM) but never reaches `apemind` when
   * the agent runs it. The CLI's documented fallback is this profile. */
  private async syncCliProfile(inst: Instance, env: Record<string, string>): Promise<void> {
    const root = this.cliConfigDir(inst.userId)
    if (!env.APEMIND_API_KEY || !env.APEMIND_BASE_URL) {
      await fsp.rm(root, { recursive: true, force: true })
      return
    }
    const profileDir = path.join(root, "profiles", "default")
    await fsp.mkdir(profileDir, { recursive: true })
    await fsp.chmod(root, 0o700)
    await fsp.chmod(path.join(root, "profiles"), 0o700)
    await fsp.chmod(profileDir, 0o700)
    await writePrivateJson(path.join(root, "config.json"), { current_profile: "default" })
    await writePrivateJson(path.join(profileDir, "state.json"), {
      base_url: env.APEMIND_BASE_URL,
      api_key: env.APEMIND_API_KEY,
    })
    if (inst.meta.uid !== undefined) {
      await chownTree(root, inst.meta.uid, inst.meta.uid)
    }
  }

  private async readInstanceEnv(inst: Instance): Promise<Record<string, string>> {
    try {
      return JSON.parse(await fsp.readFile(this.envPath(inst.userId), "utf8")) as Record<string, string>
    } catch {
      return {}
    }
  }

  private async start(inst: Instance): Promise<void> {
    if (inst.status === "running") return
    if (inst.startingPromise) return inst.startingPromise
    if (inst.restartTimer) {
      clearTimeout(inst.restartTimer)
      inst.restartTimer = undefined
    }
    inst.startingPromise = this.doStart(inst).finally(() => {
      inst.startingPromise = undefined
    })
    return inst.startingPromise
  }

  private async doStart(inst: Instance): Promise<void> {
    const port = await this.pickPort()
    inst.status = "starting"
    inst.port = port
    this.reservedPorts.delete(port)
    const home = this.homeDir(inst.userId)
    const extraEnv = await this.readInstanceEnv(inst)
    await this.syncManagedFiles(inst, extraEnv)
    if (inst.meta.uid !== undefined) {
      await chownTree(path.join(this.homeDir(inst.userId), ".apemind"), inst.meta.uid, inst.meta.uid)
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? "C.UTF-8",
      HOME: home,
      USER: inst.userId,
      DSH_HOME: path.join(home, ".dsh"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      APEMIND_USER_ID: inst.userId,
      ...extraEnv,
    }
    const hasPatch = fs.existsSync(this.patchPath(inst.userId))
    const argv: string[] = []
    for (const token of this.cfg.dshCommand) {
      if (token === "{patch}") {
        if (hasPatch) argv.push("--patch", this.patchPath(inst.userId))
        continue
      }
      argv.push(token.replace("{port}", String(port)))
    }
    const logStream = fs.createWriteStream(path.join(home, ".apemind", "dsh.log"), { flags: "a", mode: 0o600 })
    inst.error = undefined
    log.info("starting dsh", { user: inst.userId, port })
    const proc = spawn(argv[0], argv.slice(1), {
      cwd: path.join(home, "workspace"),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      uid: inst.meta.uid,
      gid: inst.meta.uid,
    })
    inst.proc = proc
    proc.stdout?.pipe(logStream, { end: false })
    proc.stderr?.pipe(logStream, { end: false })
    proc.on("exit", (code, signal) => {
      logStream.end()
      this.onExit(inst, proc, code, signal)
    })
    proc.on("error", (err) => {
      inst.status = "error"
      inst.error = `spawn failed: ${err.message}`
    })

    const deadline = Date.now() + this.cfg.readyTimeoutSec * 1000
    while (Date.now() < deadline) {
      // the exit handler can flip status to error while we await between probes
      if (inst.proc !== proc || proc.exitCode !== null || this.statusOf(inst) === "error") {
        throw new StartError(inst.error ?? "dsh exited during startup")
      }
      if (await probePort(port)) {
        inst.status = "running"
        inst.startedAt = new Date()
        inst.lastActivity = new Date()
        inst.consecutiveFailures = 0
        await this.addLoopbackRules(inst)
        log.info("dsh ready", { user: inst.userId, port, pid: proc.pid })
        return
      }
      await sleep(READY_PROBE_INTERVAL_MS)
    }
    inst.status = "error"
    inst.error = "dsh did not become ready in time"
    proc.kill("SIGKILL")
    throw new StartError(inst.error)
  }

  private onExit(inst: Instance, proc: ChildProcess, code: number | null, signal: string | null): void {
    if (inst.proc !== proc) return
    inst.proc = undefined
    void this.removeLoopbackRules(inst)
    const wasRunning = inst.status === "running"
    if (inst.stopping || this.shuttingDown) {
      inst.status = "stopped"
      return
    }
    if (inst.status === "starting") {
      inst.status = "error"
      inst.error = `dsh exited during startup (code=${code}, signal=${signal})`
      return
    }
    if (wasRunning && inst.meta.desired === "running") {
      inst.consecutiveFailures += 1
      if (inst.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
        inst.status = "error"
        inst.error = `dsh crashed repeatedly (code=${code}, signal=${signal})`
        log.error("instance gave up restarting", { user: inst.userId, code, signal })
        return
      }
      const backoffMs = Math.min(500 * 2 ** inst.consecutiveFailures, 30_000)
      inst.status = "stopped"
      log.warn("dsh exited, scheduling restart", { user: inst.userId, code, signal, backoffMs })
      inst.restartTimer = setTimeout(() => {
        inst.restartTimer = undefined
        if (inst.meta.desired === "running" && inst.status === "stopped") {
          void this.start(inst).catch((err) => log.error("restart failed", { user: inst.userId, err: String(err) }))
        }
      }, backoffMs)
      inst.restartTimer.unref()
      return
    }
    inst.status = "stopped"
  }

  private async stopProcess(inst: Instance): Promise<void> {
    if (inst.restartTimer) {
      clearTimeout(inst.restartTimer)
      inst.restartTimer = undefined
    }
    if (inst.startingPromise) {
      try {
        await inst.startingPromise
      } catch {
        // startup failed; nothing left to stop
      }
    }
    const proc = inst.proc
    if (!proc || proc.exitCode !== null) {
      if (inst.status !== "error") inst.status = "stopped"
      return
    }
    inst.stopping = true
    try {
      proc.kill("SIGTERM")
      const exited = await Promise.race([once(proc, "exit").then(() => true), sleep(this.cfg.stopGraceSec * 1000).then(() => false)])
      if (!exited) {
        proc.kill("SIGKILL")
        await once(proc, "exit")
      }
    } finally {
      inst.stopping = false
    }
    inst.status = "stopped"
    log.info("instance stopped", { user: inst.userId })
  }

  private idleSweep(): void {
    const idleMs = this.cfg.idleTimeoutSec * 1000
    if (idleMs <= 0) return
    const now = Date.now()
    for (const inst of this.instances.values()) {
      if (inst.status === "running" && now - inst.lastActivity.getTime() > idleMs) {
        log.info("idle stop", { user: inst.userId })
        // desired stays running so the next authenticated request wakes it up
        void this.stopProcess(inst).catch((err) => log.error("idle stop failed", { user: inst.userId, err: String(err) }))
      }
    }
  }

  private async pickPort(): Promise<number> {
    const used = new Set<number>(this.reservedPorts)
    for (const inst of this.instances.values()) {
      if (inst.port !== undefined && (inst.status === "running" || inst.status === "starting")) used.add(inst.port)
    }
    for (let port = this.cfg.portBase; port < this.cfg.portBase + this.cfg.maxInstances * 4; port += 1) {
      if (used.has(port)) continue
      if (await portFree(port)) {
        this.reservedPorts.add(port)
        return port
      }
    }
    throw new CapacityError("no free port")
  }

  private async addLoopbackRules(inst: Instance): Promise<void> {
    if (!this.cfg.loopbackIsolation || inst.meta.uid === undefined || inst.port === undefined) return
    const port = String(inst.port)
    const uid = String(inst.meta.uid)
    await runIptables(["-A", "OUTPUT", "-o", "lo", "-p", "tcp", "--dport", port, "-m", "owner", "--uid-owner", uid, "-j", "ACCEPT"])
    await runIptables(["-A", "OUTPUT", "-o", "lo", "-p", "tcp", "--dport", port, "-m", "owner", "!", "--uid-owner", String(process.getuid?.() ?? 0), "-j", "REJECT"])
  }

  private async removeLoopbackRules(inst: Instance): Promise<void> {
    if (!this.cfg.loopbackIsolation || inst.meta.uid === undefined || inst.port === undefined) return
    const port = String(inst.port)
    const uid = String(inst.meta.uid)
    await runIptables(["-D", "OUTPUT", "-o", "lo", "-p", "tcp", "--dport", port, "-m", "owner", "--uid-owner", uid, "-j", "ACCEPT"])
    await runIptables(["-D", "OUTPUT", "-o", "lo", "-p", "tcp", "--dport", port, "-m", "owner", "!", "--uid-owner", String(process.getuid?.() ?? 0), "-j", "REJECT"])
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
    socket.setTimeout(1000, () => done(false))
  })
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true))
    })
  })
}

async function runIptables(args: string[]): Promise<void> {
  await new Promise<void>((resolve) => {
    const proc = spawn("iptables", args, { stdio: "ignore" })
    proc.on("exit", (code) => {
      if (code !== 0) log.warn("iptables command failed", { args: args.join(" "), code })
      resolve()
    })
    proc.on("error", (err) => {
      log.warn("iptables unavailable", { err: String(err) })
      resolve()
    })
  })
}
