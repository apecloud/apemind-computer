import { loadConfig } from "./config.ts"
import { Control } from "./control.ts"
import { Gateway } from "./gateway.ts"
import { log } from "./log.ts"
import { Supervisor } from "./supervisor.ts"

async function main(): Promise<void> {
  const cfg = loadConfig()
  const supervisor = new Supervisor(cfg)
  await supervisor.init()

  const gateway = new Gateway(cfg, supervisor)
  const control = new Control(cfg, supervisor)

  gateway.server.listen(cfg.gatewayPort, () => {
    log.info("gateway listening", { port: cfg.gatewayPort, publicOrigin: cfg.publicOrigin })
  })
  control.server.listen(cfg.controlPort, () => {
    log.info("control listening", { port: cfg.controlPort })
  })

  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info("shutting down", { signal })
    gateway.server.close()
    control.server.close()
    void supervisor.shutdown().then(() => process.exit(0))
    setTimeout(() => process.exit(1), 30_000).unref()
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}

main().catch((err) => {
  log.error("fatal", { err: String(err) })
  process.exit(1)
})
