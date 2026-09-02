import * as fs from "node:fs"
import * as path from "node:path"
import { log } from "./log.ts"

export const DEFAULT_FACTORY_PATH = "/usr/local/share/apemind-computer/settings.json"
export const SETTINGS_FILENAME = "settings.json"

export const SETTINGS_KEYS = [
  "idle_timeout_sec",
  "session_ttl_sec",
  "ready_timeout_sec",
  "stop_grace_sec",
  "max_instances",
] as const

export type SettingsKey = (typeof SETTINGS_KEYS)[number]

export type HostSettings = {
  idle_timeout_sec: number
  session_ttl_sec: number
  ready_timeout_sec: number
  stop_grace_sec: number
  max_instances: number
}

export const FACTORY_SETTINGS: HostSettings = {
  idle_timeout_sec: 1800,
  session_ttl_sec: 7200,
  ready_timeout_sec: 90,
  stop_grace_sec: 10,
  max_instances: 200,
}

const RANGES: Record<SettingsKey, { min: number; max: number }> = {
  idle_timeout_sec: { min: 0, max: 86400 },
  session_ttl_sec: { min: 60, max: 604800 },
  ready_timeout_sec: { min: 5, max: 300 },
  stop_grace_sec: { min: 1, max: 120 },
  max_instances: { min: 1, max: 10000 },
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SettingsError"
  }
}

function isSettingsKey(value: string): value is SettingsKey {
  return (SETTINGS_KEYS as readonly string[]).includes(value)
}

function parseIntegerField(key: SettingsKey, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new SettingsError(`${key} must be an integer`)
  }
  const range = RANGES[key]
  if (value < range.min || value > range.max) {
    throw new SettingsError(`${key} out of range`)
  }
  return value
}

function parseCompleteSettings(raw: unknown): HostSettings | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const next = { ...FACTORY_SETTINGS }
  for (const key of SETTINGS_KEYS) {
    if (!(key in record)) return null
    try {
      next[key] = parseIntegerField(key, record[key])
    } catch {
      return null
    }
  }
  return next
}

function readFactory(factoryPath: string): HostSettings {
  try {
    const parsed = parseCompleteSettings(JSON.parse(fs.readFileSync(factoryPath, "utf8")))
    if (parsed) return parsed
  } catch {
    // Fall through to the in-code factory so tests and a missing image file still start.
  }
  return { ...FACTORY_SETTINGS }
}

function writeAtomic(file: string, settings: HostSettings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function loadOrRepair(file: string, factory: HostSettings): HostSettings {
  if (!fs.existsSync(file)) {
    writeAtomic(file, factory)
    return { ...factory }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    log.error("settings.json is not valid JSON; replacing with factory settings", { file })
    writeAtomic(file, factory)
    return { ...factory }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.error("settings.json root is not an object; replacing with factory settings", { file })
    writeAtomic(file, factory)
    return { ...factory }
  }
  const record = parsed as Record<string, unknown>
  const next = { ...factory }
  let missing = false
  let unknown = false
  for (const key of Object.keys(record)) {
    if (!isSettingsKey(key)) unknown = true
  }
  for (const key of SETTINGS_KEYS) {
    if (!(key in record)) {
      missing = true
      continue
    }
    try {
      next[key] = parseIntegerField(key, record[key])
    } catch (err) {
      log.error("settings.json field is invalid; replacing with factory settings", {
        file,
        field: key,
        err: err instanceof Error ? err.message : String(err),
      })
      writeAtomic(file, factory)
      return { ...factory }
    }
  }
  if (missing || unknown) writeAtomic(file, next)
  return next
}

export class HostSettingsStore {
  private current: HostSettings
  readonly filePath: string
  readonly factory: HostSettings

  constructor(current: HostSettings, filePath: string, factory: HostSettings) {
    this.current = current
    this.filePath = filePath
    this.factory = factory
  }

  snapshot(): HostSettings {
    return { ...this.current }
  }

  applyPatch(patch: unknown): HostSettings {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      throw new SettingsError("settings must be an object")
    }
    const record = patch as Record<string, unknown>
    const next = { ...this.current }
    for (const key of Object.keys(record)) {
      if (!isSettingsKey(key)) throw new SettingsError(`unknown setting: ${key}`)
      const value = record[key]
      if (value === null) {
        next[key] = this.factory[key]
        continue
      }
      next[key] = parseIntegerField(key, value)
    }
    writeAtomic(this.filePath, next)
    this.current = next
    return this.snapshot()
  }
}

export function settingsFilePath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_FILENAME)
}

export function loadHostSettings(dataDir: string, factoryPath: string = DEFAULT_FACTORY_PATH): HostSettingsStore {
  const factory = readFactory(factoryPath)
  const filePath = settingsFilePath(dataDir)
  const current = loadOrRepair(filePath, factory)
  return new HostSettingsStore(current, filePath, factory)
}
