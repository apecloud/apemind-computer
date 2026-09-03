// Minimal stand-in for `dsh web` used by unit tests: binds 127.0.0.1:<port>,
// reports what it sees (Host/Origin/Cookie), enforces the loopback-Host fence
// like real dsh, and echoes raw bytes on websocket upgrades.
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as http from "node:http"
import * as path from "node:path"

const args = process.argv.slice(2)
const port = Number.parseInt(args[args.indexOf("--port") + 1], 10)

if (process.env.HOME) {
  const probe = {
    argv: args,
    env: {
      APEMIND_USER_ID: process.env.APEMIND_USER_ID ?? null,
      APEMIND_INSTANCE_ID: process.env.APEMIND_INSTANCE_ID ?? null,
      APEMIND_API_KEY: process.env.APEMIND_API_KEY ?? null,
      DSH_HOME: process.env.DSH_HOME ?? null,
      DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? null,
    },
  }
  fs.mkdirSync(path.join(process.env.HOME, ".apemind"), { recursive: true })
  fs.writeFileSync(path.join(process.env.HOME, ".apemind", "probe.json"), JSON.stringify(probe))
}

function loopbackHost(req) {
  return (req.headers.host ?? "").startsWith("127.0.0.1")
}

const server = http.createServer((req, res) => {
  if (!loopbackHost(req) || req.headers.origin) {
    res.writeHead(403, { "content-type": "text/plain" })
    res.end("fence: non-loopback host or origin present")
    return
  }
  if (req.url === "/whoami") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        host: req.headers.host ?? null,
        origin: req.headers.origin ?? null,
        cookie: req.headers.cookie ?? null,
        encoding: req.headers["accept-encoding"] ?? null,
      }),
    )
    return
  }
  res.writeHead(200, { "content-type": "text/html" })
  res.end("<html><body>fake dsh</body></html>")
})

server.on("upgrade", (req, socket) => {
  if (!loopbackHost(req) || req.headers.origin) {
    socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n")
    socket.destroy()
    return
  }
  const key = req.headers["sec-websocket-key"]
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`)
  socket.on("data", (chunk) => socket.write(chunk))
})

server.listen(port, "127.0.0.1")
