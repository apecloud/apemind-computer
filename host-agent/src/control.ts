import { timingSafeEqual } from "node:crypto"
import * as http from "node:http"
import * as os from "node:os"
import type { Config } from "./config.ts"
import { log } from "./log.ts"
import { CapacityError, StartError, Supervisor, type Desired } from "./supervisor.ts"
import { USER_ID_RE } from "./ticket.ts"

const INSTANCE_PATH_RE = /^\/v1\/instances\/([A-Za-z0-9_-]{1,64})$/

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false
  const provided = Buffer.from(header.slice("Bearer ".length), "utf8")
  const wanted = Buffer.from(expected, "utf8")
  if (provided.length !== wanted.length) return false
  return timingSafeEqual(provided, wanted)
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

export class Control {
  private readonly cfg: Config
  private readonly sup: Supervisor
  readonly server: http.Server

  constructor(cfg: Config, sup: Supervisor) {
    this.cfg = cfg
    this.sup = sup
    this.server = http.createServer((req, res) => {
      void this.onRequest(req, res).catch((err) => {
        log.error("control request failed", { err: String(err) })
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" })
        else res.end()
      })
    })
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!tokenMatches(req.headers.authorization, this.cfg.controlToken)) {
      sendJson(res, 401, { error: "unauthorized" })
      return
    }
    const url = (req.url ?? "/").split("?")[0]
    if (req.method === "GET" && url === "/healthz") {
      const counts = this.sup.counts()
      sendJson(res, 200, {
        version: this.cfg.version,
        instances: { total: counts.total, running: counts.running, max: this.cfg.maxInstances },
        load1: os.loadavg()[0],
        mem_free_bytes: os.freemem(),
      })
      return
    }
    if (req.method === "GET" && url === "/v1/instances") {
      sendJson(res, 200, { instances: this.sup.list() })
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
