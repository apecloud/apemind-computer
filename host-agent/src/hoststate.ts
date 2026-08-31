import { randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { Config } from "./config.ts"
import { log } from "./log.ts"

export interface PairedInfo {
  controlToken: string
  ticketSecret: string
  mainUrl: string
  pairedAt: string
}

export type IdentityMode = "paired-file" | "preshared" | "unpaired"

export class AlreadyPairedError extends Error {}
export class NotFilePairedError extends Error {}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

/**
 * Host-level pairing identity: which control plane this host trusts and with
 * which secrets. Resolution order at startup: /data/host.json paired state,
 * then pre-shared env secrets (compat mode), otherwise unpaired and the
 * control port accepts POST /v1/pair.
 */
export class HostIdentity {
  private readonly cfg: Config
  private readonly file: string
  private paired: PairedInfo | null = null
  private readonly preshared: boolean

  constructor(cfg: Config) {
    this.cfg = cfg
    this.file = path.join(cfg.dataDir, "host.json")
    this.paired = this.readFile()
    this.preshared = this.paired === null && cfg.ticketSecret !== "" && cfg.controlToken !== ""
  }

  get mode(): IdentityMode {
    if (this.paired) return "paired-file"
    if (this.preshared) return "preshared"
    return "unpaired"
  }

  get isPaired(): boolean {
    return this.mode !== "unpaired"
  }

  get ticketSecret(): string | null {
    if (this.paired) return this.paired.ticketSecret
    return this.preshared ? this.cfg.ticketSecret : null
  }

  get controlToken(): string | null {
    if (this.paired) return this.paired.controlToken
    return this.preshared ? this.cfg.controlToken : null
  }

  get mainUrl(): string {
    return this.paired?.mainUrl ?? this.cfg.mainUrl
  }

  get pairedAt(): string | null {
    return this.paired?.pairedAt ?? null
  }

  /** Bind a control plane: generate fresh long-term secrets and persist them. */
  pair(mainUrl: string): PairedInfo {
    if (this.isPaired) throw new AlreadyPairedError("already paired")
    const info: PairedInfo = {
      controlToken: randomBytes(32).toString("base64url"),
      ticketSecret: randomBytes(32).toString("base64url"),
      mainUrl,
      pairedAt: new Date().toISOString(),
    }
    this.writeFile({
      state: "paired",
      control_token: info.controlToken,
      ticket_secret: info.ticketSecret,
      main_url: info.mainUrl,
      paired_at: info.pairedAt,
    })
    this.paired = info
    return info
  }

  setMainUrl(mainUrl: string): void {
    if (!this.paired) throw new NotFilePairedError("main_url is env-managed unless paired via /v1/pair")
    const next: PairedInfo = { ...this.paired, mainUrl }
    this.writeFile({
      state: "paired",
      control_token: next.controlToken,
      ticket_secret: next.ticketSecret,
      main_url: next.mainUrl,
      paired_at: next.pairedAt,
    })
    this.paired = next
  }

  /** Drop the pairing: secrets are deleted and the host accepts pairing again. */
  unpair(): void {
    if (!this.paired) throw new NotFilePairedError("cannot unpair a preshared-env host")
    this.writeFile({ state: "unpaired" })
    this.paired = null
  }

  private readFile(): PairedInfo | null {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, "utf8")
    } catch {
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      log.error("host.json is not valid JSON; treating host as unpaired", { file: this.file })
      return null
    }
    if (parsed === null || typeof parsed !== "object") return null
    const record = parsed as Record<string, unknown>
    if (record.state !== "paired") return null
    const controlToken = nonEmptyString(record.control_token)
    const ticketSecret = nonEmptyString(record.ticket_secret)
    const mainUrl = nonEmptyString(record.main_url)
    if (!controlToken || !ticketSecret || !mainUrl) {
      log.error("host.json paired state is incomplete; treating host as unpaired", { file: this.file })
      return null
    }
    return {
      controlToken,
      ticketSecret,
      mainUrl,
      pairedAt: nonEmptyString(record.paired_at) ?? "",
    }
  }

  private writeFile(data: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}
