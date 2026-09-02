import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import {
  DSH_IM_PACKAGE,
  EMPTY_WEB_PROFILE,
  ensureDefaultDshIm,
  mergeDshImBundle,
  mergeWorkspaceExclude,
} from "../src/dsh-im.ts"

test("merge adds the pin and bundle without dropping other plugins", () => {
  const { next, changed } = mergeDshImBundle(
    {
      ...EMPTY_WEB_PROFILE,
      dependencies: { "dsh-auth-everying": "github:example/auth" },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-auth-everying"] } },
    },
    "4.8.0",
  )
  assert.equal(changed, true)
  assert.equal(next.dependencies?.[DSH_IM_PACKAGE], "4.8.0")
  assert.equal(next.dependencies?.["dsh-auth-everying"], "github:example/auth")
  assert.deepEqual(next.dsh?.profile?.bundles, [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-auth-everying",
    DSH_IM_PACKAGE,
  ])
})

test("merge keeps a user-chosen dsh-im version", () => {
  const { next, changed } = mergeDshImBundle(
    {
      dependencies: { [DSH_IM_PACKAGE]: "4.7.0" },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", DSH_IM_PACKAGE] } },
    },
    "4.8.0",
  )
  assert.equal(changed, false)
  assert.equal(next.dependencies?.[DSH_IM_PACKAGE], "4.7.0")
})

test("workspace exclude is appended once", () => {
  const first = mergeWorkspaceExclude("packages:\n  - .\n", "@xmanrui/dsh-im@4.8.0")
  assert.match(first, /minimumReleaseAgeExclude:\n  - '@xmanrui\/dsh-im@4\.8\.0'/)
  const second = mergeWorkspaceExclude(first, "@xmanrui/dsh-im@4.8.0")
  assert.equal(second, first)
})

test("ensure is a no-op when the seed is missing", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-im-none-"))
  try {
    const result = await ensureDefaultDshIm(path.join(dir, "tenant"), path.join(dir, "missing-seed"))
    assert.equal(result.applied, false)
    assert.equal(result.reason, "seed missing")
    assert.equal(fs.existsSync(path.join(dir, "tenant", "profiles")), false)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("ensure writes the profile and copies only missing packages", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-im-seed-"))
  try {
    const seedWeb = path.join(dir, "seed", "profiles", "web")
    const seedNm = path.join(seedWeb, "node_modules")
    await fsp.mkdir(path.join(seedNm, "@xmanrui", "dsh-im"), { recursive: true })
    await fsp.mkdir(path.join(seedNm, "undici"), { recursive: true })
    await fsp.writeFile(path.join(seedNm, "@xmanrui", "dsh-im", "index.js"), "export default 1\n")
    await fsp.writeFile(path.join(seedNm, "undici", "index.js"), "export default 2\n")
    await fsp.writeFile(
      path.join(seedWeb, "package.json"),
      `${JSON.stringify({ name: "dsh-profile-web", dependencies: { [DSH_IM_PACKAGE]: "4.8.0" } }, null, 2)}\n`,
    )
    await fsp.writeFile(
      path.join(seedWeb, "pnpm-workspace.yaml"),
      "packages:\n  - .\n\nnodeLinker: hoisted\n",
    )

    const tenant = path.join(dir, "tenant")
    const tenantNm = path.join(tenant, "profiles", "web", "node_modules")
    await fsp.mkdir(path.join(tenantNm, "undici"), { recursive: true })
    await fsp.writeFile(path.join(tenantNm, "undici", "index.js"), "keep-me\n")
    await fsp.writeFile(
      path.join(tenant, "profiles", "web", "package.json"),
      `${JSON.stringify({
        name: "dsh-profile-web",
        dependencies: { leftover: "1.0.0" },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
      }, null, 2)}\n`,
    )

    const result = await ensureDefaultDshIm(tenant, path.join(dir, "seed"))
    assert.equal(result.applied, true)
    const pkg = JSON.parse(fs.readFileSync(path.join(tenant, "profiles", "web", "package.json"), "utf8"))
    assert.equal(pkg.dependencies[DSH_IM_PACKAGE], "4.8.0")
    assert.equal(pkg.dependencies.leftover, "1.0.0")
    assert.ok(pkg.dsh.profile.bundles.includes(DSH_IM_PACKAGE))
    assert.equal(fs.readFileSync(path.join(tenantNm, "undici", "index.js"), "utf8"), "keep-me\n")
    assert.equal(fs.readFileSync(path.join(tenantNm, "@xmanrui", "dsh-im", "index.js"), "utf8"), "export default 1\n")
    assert.match(fs.readFileSync(path.join(tenant, "profiles", "web", "pnpm-workspace.yaml"), "utf8"), /dsh-im@4\.8\.0/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
