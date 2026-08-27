import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, type Config } from "../src/config.ts"
import { Supervisor } from "../src/supervisor.ts"

const FAKE_DSH = fileURLToPath(new URL("./fake-dsh.mjs", import.meta.url))

export const TEST_SECRET = "test-secret-0123456789abcdef"
export const TEST_CONTROL_TOKEN = "test-control-token"
export const TEST_ORIGIN = "http://computer.test"

let nextPortBase = 34000 + Math.floor(Math.random() * 8000)

export interface TestEnv {
  cfg: Config
  sup: Supervisor
  cleanup: () => Promise<void>
}

export async function makeEnv(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "computer-host-test-"))
  nextPortBase += 50
  const cfg = loadConfig({
    COMPUTER_TICKET_SECRET: TEST_SECRET,
    COMPUTER_CONTROL_TOKEN: TEST_CONTROL_TOKEN,
    COMPUTER_PUBLIC_ORIGIN: TEST_ORIGIN,
    COMPUTER_MAIN_URL: "http://main.test",
    COMPUTER_DATA_DIR: dataDir,
    COMPUTER_DSH_COMMAND: `${process.execPath} ${FAKE_DSH} --port {port} {patch}`,
    COMPUTER_PORT_BASE: String(nextPortBase),
    COMPUTER_READY_TIMEOUT_SEC: "15",
    COMPUTER_STOP_GRACE_SEC: "2",
    COMPUTER_MAX_INSTANCES: "10",
    ...overrides,
  })
  const sup = new Supervisor(cfg)
  await sup.init()
  return {
    cfg,
    sup,
    cleanup: async () => {
      await sup.shutdown()
      await fsp.rm(dataDir, { recursive: true, force: true })
    },
  }
}

export function listen(server: import("node:http").Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (addr && typeof addr === "object") resolve(addr.port)
    })
  })
}
