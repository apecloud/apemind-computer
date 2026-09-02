import * as fsp from "node:fs/promises"
import * as path from "node:path"

/** Official npm package installed into every hosted web profile. */
export const DSH_IM_PACKAGE = "@xmanrui/dsh-im"

const WEB_REL = path.join("profiles", "web")

export interface WebProfilePackage {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
  [key: string]: unknown
}

export const EMPTY_WEB_PROFILE: WebProfilePackage = {
  name: "dsh-profile-web",
  private: true,
  dependencies: {},
  dsh: {
    profile: {
      bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
    },
  },
}

export function seedWebDir(seedDshHome: string): string {
  return path.join(seedDshHome, WEB_REL)
}

export function tenantWebDir(dshHome: string): string {
  return path.join(dshHome, WEB_REL)
}

/** Add the pinned IM plugin without replacing other deps or a user-chosen version. */
export function mergeDshImBundle(
  pkg: WebProfilePackage,
  version: string,
): { next: WebProfilePackage; changed: boolean } {
  const dependencies = { ...(pkg.dependencies ?? {}) }
  const bundles = [...(pkg.dsh?.profile?.bundles ?? EMPTY_WEB_PROFILE.dsh!.profile!.bundles!)]
  let changed = false
  if (dependencies[DSH_IM_PACKAGE] === undefined) {
    dependencies[DSH_IM_PACKAGE] = version
    changed = true
  }
  if (!bundles.includes(DSH_IM_PACKAGE)) {
    bundles.push(DSH_IM_PACKAGE)
    changed = true
  }
  const next: WebProfilePackage = {
    ...pkg,
    dependencies,
    dsh: {
      ...pkg.dsh,
      profile: {
        ...pkg.dsh?.profile,
        bundles,
      },
    },
  }
  return { next, changed }
}

export function mergeWorkspaceExclude(text: string, spec: string): string {
  const quoted = `'${spec}'`
  if (text.includes(quoted) || text.includes(spec)) return text
  if (/minimumReleaseAgeExclude:\s*$/m.test(text) || /minimumReleaseAgeExclude:\s*\n/.test(text)) {
    return text.replace(/minimumReleaseAgeExclude:\s*\n/, `minimumReleaseAgeExclude:\n  - ${quoted}\n`)
  }
  const suffix = text.endsWith("\n") ? "" : "\n"
  return `${text}${suffix}minimumReleaseAgeExclude:\n  - ${quoted}\n`
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

async function readJson(target: string): Promise<unknown> {
  return JSON.parse(await fsp.readFile(target, "utf8"))
}

async function copyMissing(src: string, dest: string): Promise<boolean> {
  if (await pathExists(dest)) return false
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.cp(src, dest, { recursive: true })
  return true
}

async function overlayNodeModules(seedNm: string, tenantNm: string): Promise<number> {
  if (!(await pathExists(seedNm))) return 0
  await fsp.mkdir(tenantNm, { recursive: true })
  let copied = 0
  for (const entry of await fsp.readdir(seedNm, { withFileTypes: true })) {
    if (entry.name === ".pnpm") continue
    const src = path.join(seedNm, entry.name)
    const dest = path.join(tenantNm, entry.name)
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      await fsp.mkdir(dest, { recursive: true })
      for (const scoped of await fsp.readdir(src)) {
        if (await copyMissing(path.join(src, scoped), path.join(dest, scoped))) copied += 1
      }
      continue
    }
    if (entry.name === ".bin" && entry.isDirectory()) {
      await fsp.mkdir(dest, { recursive: true })
      for (const bin of await fsp.readdir(src)) {
        if (await copyMissing(path.join(src, bin), path.join(dest, bin))) copied += 1
      }
      continue
    }
    if (await copyMissing(src, dest)) copied += 1
  }
  return copied
}

export interface EnsureDshImResult {
  applied: boolean
  reason: string
}

/**
 * Make sure a tenant web profile lists and can load the baked IM plugin.
 * Missing seed (dev / unit tests) is a no-op. Existing extra plugins stay.
 */
export async function ensureDefaultDshIm(dshHome: string, seedDshHome: string): Promise<EnsureDshImResult> {
  const seed = seedDshHome.trim()
  if (seed === "") return { applied: false, reason: "seed disabled" }
  const seedPkgPath = path.join(seedWebDir(seed), "package.json")
  if (!(await pathExists(seedPkgPath))) return { applied: false, reason: "seed missing" }
  let seedPkg: WebProfilePackage
  try {
    seedPkg = (await readJson(seedPkgPath)) as WebProfilePackage
  } catch {
    return { applied: false, reason: "seed package unreadable" }
  }
  const version = seedPkg.dependencies?.[DSH_IM_PACKAGE]
  if (typeof version !== "string" || version.trim() === "") {
    return { applied: false, reason: "seed has no dsh-im pin" }
  }

  const web = tenantWebDir(dshHome)
  await fsp.mkdir(web, { recursive: true })
  const pkgPath = path.join(web, "package.json")
  let pkg: WebProfilePackage = EMPTY_WEB_PROFILE
  if (await pathExists(pkgPath)) {
    try {
      pkg = (await readJson(pkgPath)) as WebProfilePackage
    } catch {
      pkg = EMPTY_WEB_PROFILE
    }
  }
  const merged = mergeDshImBundle(pkg, version)
  let changed = merged.changed || !(await pathExists(pkgPath))
  if (changed) {
    await fsp.writeFile(pkgPath, `${JSON.stringify(merged.next, null, 2)}\n`, { mode: 0o644 })
  }

  const seedWs = path.join(seedWebDir(seed), "pnpm-workspace.yaml")
  const tenantWs = path.join(web, "pnpm-workspace.yaml")
  if (await pathExists(seedWs)) {
    const spec = `${DSH_IM_PACKAGE}@${version}`
    if (await pathExists(tenantWs)) {
      const current = await fsp.readFile(tenantWs, "utf8")
      const next = mergeWorkspaceExclude(current, spec)
      if (next !== current) {
        await fsp.writeFile(tenantWs, next.endsWith("\n") ? next : `${next}\n`, { mode: 0o644 })
        changed = true
      }
    } else {
      const seedText = await fsp.readFile(seedWs, "utf8")
      await fsp.writeFile(tenantWs, mergeWorkspaceExclude(seedText, spec), { mode: 0o644 })
      changed = true
    }
  }

  for (const name of ["cordis.yml", "cordis.patch.yml"] as const) {
    const dest = path.join(web, name)
    const src = path.join(seedWebDir(seed), name)
    if (!(await pathExists(dest)) && (await pathExists(src))) {
      await fsp.copyFile(src, dest)
      changed = true
    }
  }

  const copied = await overlayNodeModules(
    path.join(seedWebDir(seed), "node_modules"),
    path.join(web, "node_modules"),
  )
  return { applied: changed || copied > 0, reason: "ok" }
}
