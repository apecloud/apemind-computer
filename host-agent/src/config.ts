export interface Config {
  /** Pre-shared secrets (compat mode). Empty when the host pairs via /v1/pair. */
  ticketSecret: string
  controlToken: string
  /** Optional operator-set bootstrap code required by POST /v1/pair when non-empty. */
  pairCode: string
  /** Public origin of the gateway, e.g. https://computer.apemind.ai */
  publicOrigin: string
  /** Where to send browsers that have no instance or no valid session. */
  mainUrl: string
  dataDir: string
  gatewayPort: number
  controlPort: number
  portBase: number
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
  /** Optional helper that sets PR_SET_PDEATHSIG + a new process group before exec. */
  dshExec: string
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
  const ticketSecret = (env.COMPUTER_TICKET_SECRET ?? "").trim()
  const controlToken = (env.COMPUTER_CONTROL_TOKEN ?? "").trim()
  if ((ticketSecret === "") !== (controlToken === "")) {
    throw new Error("COMPUTER_TICKET_SECRET and COMPUTER_CONTROL_TOKEN must be set together or both omitted")
  }
  return {
    ticketSecret,
    controlToken,
    pairCode: (env.COMPUTER_PAIR_CODE ?? "").trim(),
    publicOrigin,
    mainUrl: (env.COMPUTER_MAIN_URL ?? "https://apemind.ai").replace(/\/+$/, ""),
    dataDir: env.COMPUTER_DATA_DIR ?? "/data",
    gatewayPort: intEnv(env, "COMPUTER_GATEWAY_PORT", 8080),
    controlPort: intEnv(env, "COMPUTER_CONTROL_PORT", 9090),
    portBase: intEnv(env, "COMPUTER_PORT_BASE", 31000),
    dshCommand: (env.COMPUTER_DSH_COMMAND ?? "dsh {patch} --profile web --no-open --port {port}").split(/\s+/).filter(Boolean),
    uidBase: intEnv(env, "COMPUTER_UID_BASE", 0),
    loopbackIsolation: (env.COMPUTER_LOOPBACK_ISOLATION ?? "").trim() === "1",
    dshExec: (env.COMPUTER_DSH_EXEC ?? "/usr/local/bin/dsh-exec").trim(),
    version: env.COMPUTER_VERSION ?? "dev",
  }
}
