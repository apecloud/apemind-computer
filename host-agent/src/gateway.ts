import * as http from "node:http"
import * as net from "node:net"
import type { Duplex } from "node:stream"
import type { Config } from "./config.ts"
import { log } from "./log.ts"
import { Supervisor } from "./supervisor.ts"
import { signToken, verifyToken, type TokenPayload } from "./ticket.ts"

export const SESSION_COOKIE = "computer_session"

/** Request headers never forwarded to dsh. Origin/referer/sec-fetch-* must be
 * stripped so dsh's loopback trust fence treats the request as a plain
 * loopback client; hop-by-hop headers are managed by the proxy itself. */
const DROP_REQUEST_HEADERS = new Set([
  "host",
  "origin",
  "referer",
  "connection",
  "upgrade",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "accept-encoding",
  "content-length",
])

const DROP_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade"])

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key === name) {
      let value = rest.join("=")
      if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
        value = value.slice(1, -1)
      }
      return value
    }
  }
  return undefined
}

function stripSessionCookie(header: string): string {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${SESSION_COOKIE}=`))
    .join("; ")
}

function wantsHtml(req: http.IncomingMessage): boolean {
  return (req.method === "GET" || req.method === "HEAD") && (req.headers.accept ?? "").includes("text/html")
}

export class Gateway {
  private readonly cfg: Config
  private readonly sup: Supervisor
  private readonly usedNonces = new Map<string, number>()
  readonly server: http.Server

  constructor(cfg: Config, sup: Supervisor) {
    this.cfg = cfg
    this.sup = sup
    this.server = http.createServer((req, res) => {
      void this.onRequest(req, res).catch((err) => {
        log.error("gateway request failed", { err: String(err) })
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
        }
        res.end("bad gateway")
      })
    })
    this.server.on("upgrade", (req, socket, head) => {
      void this.onUpgrade(req, socket, head).catch((err) => {
        log.error("gateway upgrade failed", { err: String(err) })
        socket.destroy()
      })
    })
    const cleanup = setInterval(() => this.cleanupNonces(), 60_000)
    cleanup.unref()
  }

  private cleanupNonces(): void {
    const now = nowSec()
    for (const [key, exp] of this.usedNonces) {
      if (exp <= now) this.usedNonces.delete(key)
    }
  }

  private originAllowed(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin
    if (origin === undefined || origin === "null") return true
    return origin.replace(/\/+$/, "") === this.cfg.publicOrigin
  }

  private session(req: http.IncomingMessage): TokenPayload | null {
    const raw = cookieValue(req.headers.cookie, SESSION_COOKIE)
    if (!raw) return null
    return verifyToken(raw, this.cfg.ticketSecret, "session", nowSec())
  }

  private redirect(res: http.ServerResponse, url: string): void {
    res.writeHead(302, { location: url, "cache-control": "no-store" })
    res.end()
  }

  private deny(res: http.ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
    res.end(message)
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? "/"
    if (url === "/__healthz") {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("ok")
      return
    }
    if (!this.originAllowed(req)) {
      this.deny(res, 403, "origin not allowed")
      return
    }
    if (url.startsWith("/open/")) {
      this.redeemTicket(url, res)
      return
    }
    const session = this.session(req)
    if (!session) {
      if (wantsHtml(req)) this.redirect(res, `${this.cfg.mainUrl}/workspace/computer`)
      else this.deny(res, 401, "no computer session")
      return
    }
    const inst = this.sup.get(session.userId)
    if (!inst) {
      if (wantsHtml(req)) this.redirect(res, `${this.cfg.mainUrl}/workspace/computer`)
      else this.deny(res, 404, "no computer instance")
      return
    }
    if (inst.meta.desired !== "running") {
      if (wantsHtml(req)) this.redirect(res, `${this.cfg.mainUrl}/workspace/computer`)
      else this.deny(res, 503, "computer is stopped")
      return
    }
    if (inst.status !== "running") {
      try {
        await this.sup.wake(session.userId)
      } catch {
        this.deny(res, 502, "dsh failed to start")
        return
      }
    }
    const port = this.sup.get(session.userId)?.port
    if (port === undefined) {
      this.deny(res, 503, "dsh is not ready")
      return
    }
    this.sup.touch(session.userId)
    this.proxyHttp(req, res, port)
  }

  private redeemTicket(url: string, res: http.ServerResponse): void {
    let raw: string
    try {
      raw = decodeURIComponent(url.slice("/open/".length).split("?")[0])
    } catch {
      this.deny(res, 403, "invalid or expired ticket")
      return
    }
    const payload = verifyToken(raw, this.cfg.ticketSecret, "ticket", nowSec())
    if (!payload || !payload.nonce) {
      this.deny(res, 403, "invalid or expired ticket")
      return
    }
    const nonceKey = `${payload.userId}:${payload.nonce}`
    if (this.usedNonces.has(nonceKey)) {
      this.deny(res, 403, "ticket already used")
      return
    }
    this.usedNonces.set(nonceKey, payload.exp)
    const sessionToken = signToken(this.cfg.ticketSecret, {
      type: "session",
      userId: payload.userId,
      exp: nowSec() + this.cfg.sessionTtlSec,
    })
    const attrs = [
      `${SESSION_COOKIE}=${sessionToken}`,
      "HttpOnly",
      "SameSite=Lax",
      "Path=/",
      `Max-Age=${this.cfg.sessionTtlSec}`,
    ]
    if (this.cfg.publicOrigin.startsWith("https://")) attrs.push("Secure")
    res.writeHead(302, { location: "/", "set-cookie": attrs.join("; "), "cache-control": "no-store" })
    res.end()
    log.info("ticket redeemed", { user: payload.userId })
  }

  private upstreamHeaders(req: http.IncomingMessage, port: number): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = key.toLowerCase()
      if (DROP_REQUEST_HEADERS.has(lower) || lower.startsWith("sec-fetch-")) continue
      if (lower === "cookie") {
        const kept = stripSessionCookie(String(value))
        if (kept) headers.cookie = kept
        continue
      }
      headers[lower] = value
    }
    headers.host = `127.0.0.1:${port}`
    headers["accept-encoding"] = "identity"
    return headers
  }

  private proxyHttp(req: http.IncomingMessage, res: http.ServerResponse, port: number): void {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port,
        path: req.url,
        method: req.method,
        headers: this.upstreamHeaders(req, port),
      },
      (upstreamRes) => {
        const headers: Record<string, string | string[] | number> = {}
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined || DROP_RESPONSE_HEADERS.has(key.toLowerCase())) continue
          headers[key] = value
        }
        headers["x-accel-buffering"] = "no"
        res.writeHead(upstreamRes.statusCode ?? 502, headers)
        upstreamRes.pipe(res)
      },
    )
    upstream.on("error", () => {
      if (!res.headersSent) this.deny(res, 502, "dsh is unreachable")
      else res.destroy()
    })
    req.pipe(upstream)
    req.on("error", () => upstream.destroy())
    res.on("close", () => upstream.destroy())
  }

  private async onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const denyRaw = (status: number, message: string) => {
      socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ""}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${message}`)
      socket.destroy()
    }
    if (!this.originAllowed(req)) {
      denyRaw(403, "origin not allowed")
      return
    }
    const session = this.session(req)
    if (!session) {
      denyRaw(403, "no computer session")
      return
    }
    const inst = this.sup.get(session.userId)
    if (!inst || inst.meta.desired !== "running") {
      denyRaw(403, "computer is not running")
      return
    }
    if (inst.status !== "running") {
      try {
        await this.sup.wake(session.userId)
      } catch {
        denyRaw(502, "dsh failed to start")
        return
      }
    }
    const port = this.sup.get(session.userId)?.port
    if (port === undefined) {
      denyRaw(503, "dsh is not ready")
      return
    }
    this.sup.touch(session.userId)

    const upstream = net.connect({ host: "127.0.0.1", port })
    upstream.on("connect", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      const raw = req.rawHeaders
      let cookieSent = false
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const name = raw[i]
        const value = raw[i + 1]
        const lower = name.toLowerCase()
        if (lower === "host") {
          continue
        }
        if (lower === "origin" || lower === "referer" || lower.startsWith("sec-fetch-")) continue
        if (lower === "cookie") {
          const kept = stripSessionCookie(value)
          if (kept && !cookieSent) {
            lines.push(`cookie: ${kept}`)
            cookieSent = true
          }
          continue
        }
        lines.push(`${name}: ${value}`)
      }
      lines.push(`host: 127.0.0.1:${port}`)
      lines.push("", "")
      upstream.write(lines.join("\r\n"))
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    let lastTouch = Date.now()
    const touch = () => {
      const now = Date.now()
      if (now - lastTouch > 1000) {
        lastTouch = now
        this.sup.touch(session.userId)
      }
    }
    upstream.on("data", touch)
    socket.on("data", touch)
    const teardown = () => {
      upstream.destroy()
      socket.destroy()
    }
    upstream.on("error", teardown)
    upstream.on("close", teardown)
    socket.on("error", teardown)
    socket.on("close", teardown)
  }
}
