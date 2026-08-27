export interface Config {
  ticketSecret: string
  controlToken: string
  /** Public origin of the gateway, e.g. https://computer.apemind.ai */
  publicOrigin: string
  /** Where to send browsers that have no instance or no valid session. */
  mainUrl: string
  dataDir: string
  gatewayPort: number
  controlPort: number
  portBase: number
  maxInstances: number
  idleTimeoutSec: number
  sessionTtlSec: number
  readyTimeoutSec: number
  stopGraceSec: number
  /**
   * Command template used to start one dsh instance. {port} is replaced with the
   * assigned loopback port; {patch} expands to `--patch <file>` when a managed
   * cordis patch exists for the instance (dsh launcher flags must come before
   * the web app's own flags, hence the explicit placeholder).
   */
  dshCommand: string[]
  /** 0 disables per-instance uid isolation; >0 is the first uid to allocate. */
  uidBase: number
  /** Requires uidBase > 0 and NET_ADMIN; installs loopback iptables rules per instance. */
  loopbackIsolation: boolean
  version: string
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got: ${raw}`)
  return value
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const raw = (env[name] ?? "").trim()
  if (!raw) throw new Error(`${name} is required`)
  return raw
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicOrigin = requireEnv(env, "COMPUTER_PUBLIC_ORIGIN").replace(/\/+$/, "")
  if (!/^https?:\/\//.test(publicOrigin)) throw new Error("COMPUTER_PUBLIC_ORIGIN must start with http:// or https://")
  return {
    ticketSecret: requireEnv(env, "COMPUTER_TICKET_SECRET"),
    controlToken: requireEnv(env, "COMPUTER_CONTROL_TOKEN"),
    publicOrigin,
    mainUrl: (env.COMPUTER_MAIN_URL ?? "https://apemind.ai").replace(/\/+$/, ""),
    dataDir: env.COMPUTER_DATA_DIR ?? "/data",
    gatewayPort: intEnv(env, "COMPUTER_GATEWAY_PORT", 8080),
    controlPort: intEnv(env, "COMPUTER_CONTROL_PORT", 9090),
    portBase: intEnv(env, "COMPUTER_PORT_BASE", 31000),
    maxInstances: intEnv(env, "COMPUTER_MAX_INSTANCES", 200),
    idleTimeoutSec: intEnv(env, "COMPUTER_IDLE_TIMEOUT_SEC", 1800),
    sessionTtlSec: intEnv(env, "COMPUTER_SESSION_TTL_SEC", 43200),
    readyTimeoutSec: intEnv(env, "COMPUTER_READY_TIMEOUT_SEC", 90),
    stopGraceSec: intEnv(env, "COMPUTER_STOP_GRACE_SEC", 10),
    dshCommand: (env.COMPUTER_DSH_COMMAND ?? "dsh {patch} --profile web --no-open --port {port}").split(/\s+/).filter(Boolean),
    uidBase: intEnv(env, "COMPUTER_UID_BASE", 0),
    loopbackIsolation: (env.COMPUTER_LOOPBACK_ISOLATION ?? "").trim() === "1",
    version: env.COMPUTER_VERSION ?? "dev",
  }
}
