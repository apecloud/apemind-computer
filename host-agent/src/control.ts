import { timingSafeEqual } from "node:crypto"
import * as http from "node:http"
import * as os from "node:os"
import type { Config } from "./config.ts"
import { AlreadyPairedError, HostIdentity, NotFilePairedError } from "./hoststate.ts"
import { log } from "./log.ts"
import { SettingsError } from "./settings.ts"
import { CapacityError, StartError, Supervisor, type Desired } from "./supervisor.ts"
import { USER_ID_RE } from "./ticket.ts"

const INSTANCE_PATH_RE = /^\/v1\/instances\/([A-Za-z0-9_-]{1,64})$/
const REVOKE_SESSIONS_PATH_RE = /^\/v1\/instances\/([A-Za-z0-9_-]{1,64})\/revoke-sessions$/

function bearerValue(header: string | undefined): string | null {
  if (!header || !header.startsWith("Bearer ")) return null
  return header.slice("Bearer ".length)
}

function secretEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8")
  const b = Buffer.from(expected, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function tokenMatches(header: string | undefined, expected: string | null): boolean {
  if (expected === null) return false
  const provided = bearerValue(header)
  if (provided === null) return false
  return secretEquals(provided, expected)
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(`${JSON.stringify(body)}\n`)
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64 * 1024) throw new Error("body too large")
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function parseHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  const text = value.trim().replace(/\/+$/, "")
  if (text === "") return null
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return null
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  return text
}

export class Control {
  private readonly cfg: Config
  private readonly identity: HostIdentity
  private readonly sup: Supervisor
  readonly server: http.Server

  constructor(cfg: Config, identity: HostIdentity, sup: Supervisor) {
    this.cfg = cfg
    this.identity = identity
    this.sup = sup
    this.server = http.createServer((req, res) => {
      void this.onRequest(req, res).catch((err) => {
        log.error("control request failed", { err: String(err) })
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" })
        else res.end()
      })
    })
  }

  private runtimeView(): Record<string, unknown> {
    const view: Record<string, unknown> = {
      state: this.identity.isPaired ? "paired" : "unpaired",
      public_origin: this.cfg.publicOrigin,
      version: this.cfg.version,
    }
    if (this.identity.isPaired) {
      view.main_url = this.identity.mainUrl
      if (this.identity.pairedAt) view.paired_at = this.identity.pairedAt
      view.settings = this.sup.settings.snapshot()
    }
    return view
  }

  private async handlePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.identity.isPaired) {
      sendJson(res, 409, { error: "already paired" })
      return
    }
    // Pairing callers are server-side processes; a present Origin header means a
    // browser is being used to reach the private control port (CSRF / DNS
    // rebinding), so reject it outright. Strict JSON content-type closes the
    // form-post variant of the same attack.
    if (req.headers.origin !== undefined) {
      sendJson(res, 403, { error: "origin header not allowed" })
      return
    }
    const contentType = (req.headers["content-type"] ?? "").toLowerCase()
    if (!contentType.startsWith("application/json")) {
      sendJson(res, 403, { error: "content-type must be application/json" })
      return
    }
    if (this.cfg.pairCode !== "") {
      const provided = bearerValue(req.headers.authorization)
      if (provided === null || !secretEquals(provided, this.cfg.pairCode)) {
        sendJson(res, 401, { error: "pair code required" })
        return
      }
    }
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { error: "invalid json body" })
      return
    }
    const mainUrl = parseHttpUrl((body as Record<string, unknown>)?.main_url)
    if (mainUrl === null) {
      sendJson(res, 400, { error: "main_url must be an http(s) URL" })
      return
    }
    let info
    try {
      info = this.identity.pair(mainUrl)
    } catch (err) {
      if (err instanceof AlreadyPairedError) {
        sendJson(res, 409, { error: "already paired" })
        return
      }
      throw err
    }
    log.info("paired with control plane", { peer: req.socket.remoteAddress ?? "", main_url: mainUrl })
    sendJson(res, 200, {
      public_origin: this.cfg.publicOrigin,
      control_token: info.controlToken,
      ticket_secret: info.ticketSecret,
      paired_at: info.pairedAt,
    })
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url ?? "/").split("?")[0]
    if (req.method === "POST" && url === "/v1/pair") {
      await this.handlePair(req, res)
      return
    }
    if (req.method === "GET" && url === "/v1/runtime" && !this.identity.isPaired) {
      // Nothing here is secret; lets the control plane show the origin it is
      // about to bind before confirming the pair.
      sendJson(res, 200, this.runtimeView())
      return
    }
    if (!tokenMatches(req.headers.authorization, this.identity.controlToken)) {
      sendJson(res, 401, { error: "unauthorized" })
      return
    }
    if (req.method === "GET" && url === "/v1/runtime") {
      sendJson(res, 200, this.runtimeView())
      return
    }
    if (req.method === "PUT" && url === "/v1/runtime") {
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, { error: "invalid json body" })
        return
      }
      const record = (body ?? {}) as Record<string, unknown>
      const wantsSettings = record.settings !== undefined
      const wantsMain = record.main_url !== undefined
      if (!wantsSettings && !wantsMain) {
        sendJson(res, 400, { error: "main_url must be an http(s) URL" })
        return
      }
      let mainUrl: string | null = null
      if (wantsMain) {
        mainUrl = parseHttpUrl(record.main_url)
        if (mainUrl === null) {
          sendJson(res, 400, { error: "main_url must be an http(s) URL" })
          return
        }
      }
      if (wantsSettings) {
        try {
          this.sup.settings.applyPatch(record.settings)
          this.sup.applyInstanceLimits()
        } catch (err) {
          if (err instanceof SettingsError) {
            sendJson(res, 400, { error: err.message })
            return
          }
          throw err
        }
      }
      if (mainUrl !== null) {
        try {
          this.identity.setMainUrl(mainUrl)
        } catch (err) {
          if (err instanceof NotFilePairedError) {
            sendJson(res, 409, { error: err.message })
            return
          }
          throw err
        }
      }
      sendJson(res, 200, this.runtimeView())
      return
    }
    if (req.method === "POST" && url === "/v1/unpair") {
      try {
        this.identity.unpair()
      } catch (err) {
        if (err instanceof NotFilePairedError) {
          sendJson(res, 409, { error: err.message })
          return
        }
        throw err
      }
      log.info("unpaired from control plane", { peer: req.socket.remoteAddress ?? "" })
      sendJson(res, 200, this.runtimeView())
      return
    }
    if (req.method === "GET" && url === "/healthz") {
      const counts = this.sup.counts()
      sendJson(res, 200, {
        version: this.cfg.version,
        public_origin: this.cfg.publicOrigin,
        instances: { total: counts.total, running: counts.running, max: this.sup.settings.snapshot().max_instances },
        load1: os.loadavg()[0],
        mem_free_bytes: os.freemem(),
      })
      return
    }
    if (req.method === "GET" && url === "/v1/instances") {
      sendJson(res, 200, { instances: this.sup.list() })
      return
    }
    const revokeMatch = REVOKE_SESSIONS_PATH_RE.exec(url)
    if (revokeMatch) {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" })
        return
      }
      const view = await this.sup.revokeSessions(revokeMatch[1])
      if (!view) sendJson(res, 404, { error: "instance not found" })
      else sendJson(res, 200, view)
      return
    }
    const match = INSTANCE_PATH_RE.exec(url)
    if (!match) {
      sendJson(res, 404, { error: "not found" })
      return
    }
    const userId = match[1]
    if (req.method === "GET") {
      const view = this.sup.getView(userId)
      if (!view) sendJson(res, 404, { error: "instance not found" })
      else sendJson(res, 200, view)
      return
    }
    if (req.method === "DELETE") {
      const removed = await this.sup.remove(userId)
      if (!removed) sendJson(res, 404, { error: "instance not found" })
      else {
        res.writeHead(204)
        res.end()
      }
      return
    }
    if (req.method === "PUT") {
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, { error: "invalid json body" })
        return
      }
      const record = (body ?? {}) as Record<string, unknown>
      const desired = record.desired
      if (desired !== "running" && desired !== "stopped") {
        sendJson(res, 400, { error: "desired must be running or stopped" })
        return
      }
      let env: Record<string, string> | undefined
      if (record.env !== undefined) {
        if (record.env === null || typeof record.env !== "object" || Array.isArray(record.env)) {
          sendJson(res, 400, { error: "env must be an object of strings" })
          return
        }
        env = {}
        for (const [key, value] of Object.entries(record.env as Record<string, unknown>)) {
          if (typeof value !== "string") {
            sendJson(res, 400, { error: `env.${key} must be a string` })
            return
          }
          env[key] = value
        }
      }
      if (!USER_ID_RE.test(userId)) {
        sendJson(res, 400, { error: "invalid user_id" })
        return
      }
      try {
        const view = await this.sup.ensure(userId, desired as Desired, env)
        sendJson(res, 200, view)
      } catch (err) {
        if (err instanceof CapacityError) sendJson(res, 507, { error: err.message })
        else if (err instanceof StartError) sendJson(res, 409, { error: err.message })
        else if (err instanceof Error && err.message.startsWith("invalid")) sendJson(res, 400, { error: err.message })
        else throw err
      }
      return
    }
    sendJson(res, 405, { error: "method not allowed" })
  }
}
