import { loadConfig } from "./config.ts"
import { Control } from "./control.ts"
import { Gateway } from "./gateway.ts"
import { HostIdentity } from "./hoststate.ts"
import { log } from "./log.ts"
import { loadHostSettings } from "./settings.ts"
import { Supervisor } from "./supervisor.ts"

async function main(): Promise<void> {
  const cfg = loadConfig()
  const settings = loadHostSettings(cfg.dataDir)
  const supervisor = new Supervisor(cfg, settings)
  await supervisor.init()

  const identity = new HostIdentity(cfg)
  log.info("host identity", { mode: identity.mode })
  if (identity.mode === "unpaired") {
    log.info("unpaired: control port accepts POST /v1/pair", { pairCodeRequired: cfg.pairCode !== "" })
  }

  const gateway = new Gateway(cfg, identity, supervisor)
  const control = new Control(cfg, identity, supervisor)

  await Promise.all([
    new Promise<void>((resolve, reject) => {
      gateway.server.once("error", reject)
      gateway.server.listen(cfg.gatewayPort, () => {
        log.info("gateway listening", { port: cfg.gatewayPort, publicOrigin: cfg.publicOrigin })
        resolve()
      })
    }),
    new Promise<void>((resolve, reject) => {
      control.server.once("error", reject)
      control.server.listen(cfg.controlPort, () => {
        log.info("control listening", { port: cfg.controlPort })
        resolve()
      })
    }),
  ])
  void supervisor.resumeKeptInstances()

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
