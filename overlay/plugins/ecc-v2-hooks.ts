/**
 * ECC hooks, V2-native shim
 *
 * The upstream ECC plugin (.opencode/plugins/ecc-hooks.ts) is written against
 * the V1 OpenCode plugin API (a default-exported factory returning a V1 event
 * dictionary) and is rejected by the V2 plugin loader. Until ECC ships a V2
 * plugin, this shim implements the same STANDARD-profile behavior on the V2
 * API natively:
 *
 *   - console.log warning after JS/TS edits        (post:edit:console-warn)
 *   - "is this doc necessary" warning before write (pre:write:doc-file-warning)
 *   - "PR created" log for gh pr create           (post:bash:pr-created)
 *   - session-idle console.log audit + desktop
 *     notification                                 (stop:check-console-log)
 *   - shell env injection: PROJECT_ROOT, PACKAGE_MANAGER,
 *     DETECTED_LANGUAGES, PRIMARY_LANGUAGE,
 *     ECC_VERSION/ECC_PLUGIN/ECC_HOOK_PROFILE,
 *     CLAUDE_PLUGIN_ROOT (ECC commands resolve their
 *     scripts through it)                          (shell.env)
 *
 * Deliberately NOT ported: prettier auto-format and tsc checks are
 * STRICT-profile in ECC (inactive in standard), and skill-run telemetry writes
 * through ECC's own CJS tracker (add later if you use skills-health).
 *
 * ECC_HOOK_PROFILE=minimal disables the audit/warning hooks (env injection
 * stays — ECC's slash commands need it). ECC_DISABLED_HOOKS=comma,ids kills
 * individual hooks by their ECC ids.
 */
import { Plugin } from "@opencode/plugin"
import * as fs from "fs"
import * as path from "path"

type Json = Record<string, unknown>

const PROFILE_ORDER: Record<string, number> = { minimal: 0, standard: 1, strict: 2 }
const currentProfile = process.env.ECC_HOOK_PROFILE ?? "standard"
const disabled = new Set(
  (process.env.ECC_DISABLED_HOOKS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
)

function hookEnabled(id: string, required: string | string[]): boolean {
  if (disabled.has(id)) return false
  const needed = Array.isArray(required) ? required : [required]
  return needed.some((r) => (PROFILE_ORDER[currentProfile] ?? 1) >= (PROFILE_ORDER[r] ?? 1))
}

function log(_ctx: unknown, level: "info" | "warn", message: string) {
  // V2 plugins log through the server console; ctx.app.log was the V1 client API.
  try {
    if (level === "warn") console.warn(`[ecc] ${message}`)
    else console.log(`[ecc] ${message}`)
  } catch {}
}

function toolPath(input: unknown): string | null {
  const args = (input ?? {}) as Json
  const p = args.path ?? args.filePath ?? args.file_path
  return typeof p === "string" && p.trim() ? p : null
}

function pluginDir(): string {
  // ESM has no __dirname; keep the CJS check first so a compiled consumer
  // still resolves correctly (the same trap ECC's own plugin documents).
  if (typeof __dirname === "string" && __dirname) return __dirname
  return path.dirname(new URL(import.meta.url).pathname)
}

function eccVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir(), "..", "package.json"), "utf-8"))
    if (typeof pkg.version === "string") return pkg.version
  } catch {}
  return "2.2.3"
}

const ECC_ROOT = path.resolve(pluginDir(), "..")

export default Plugin.define({
  id: "ecc-v2-hooks",
  async setup(ctx) {
    const worktree = ctx.location.directory
    const editedFiles = new Set<string>()
    const lockfiles: Record<string, string> = {
      "bun.lockb": "bun",
      "pnpm-lock.yaml": "pnpm",
      "yarn.lock": "yarn",
      "package-lock.json": "npm",
    }
    const langDetectors: Record<string, string> = {
      "tsconfig.json": "typescript",
      "go.mod": "go",
      "pyproject.toml": "python",
      "Cargo.toml": "rust",
      "Package.swift": "swift",
    }

    await ctx.tool.hook("execute.before", (event) => {
      if (
        event.tool === "write" &&
        hookEnabled("pre:write:doc-file-warning", ["standard", "strict"])
      ) {
        const p = toolPath(event.input)
        if (
          p &&
          /\.(md|txt)$/i.test(p) &&
          !["README", "CHANGELOG", "LICENSE", "CONTRIBUTING"].some((n) => path.basename(p).includes(n))
        ) {
          log(ctx, "warn", `[ECC] Creating ${p} — consider if this documentation is necessary`)
        }
      }
    })

    await ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return
      if (event.tool === "edit") {
        const p = toolPath(event.input)
        if (!p) return
        editedFiles.add(p)
        if (hookEnabled("post:edit:console-warn", ["standard", "strict"]) && /\.(ts|tsx|js|jsx)$/.test(p)) {
          try {
            const text = fs.readFileSync(p, "utf-8")
            const hits = text.split("\n").filter((l) => l.includes("console.log")).length
            if (hits > 0) log(ctx, "warn", `[ECC] console.log found in ${p} (${hits} occurrence${hits > 1 ? "s" : ""})`)
          } catch {
            /* file unreadable — skip */
          }
        }
      }
      if (
        event.tool === "bash" &&
        hookEnabled("post:bash:pr-created", ["standard", "strict"]) &&
        JSON.stringify(event.input ?? {}).includes("gh pr create")
      ) {
        log(ctx, "info", "[ECC] PR created — check GitHub Actions status")
      }
    })

    await ctx.shell.hook("create.before", (event) => {
      const env = event.env
      env.ECC_VERSION = eccVersion()
      env.ECC_PLUGIN = "true"
      env.ECC_HOOK_PROFILE = currentProfile
      env.PROJECT_ROOT = worktree
      // ECC commands resolve their scripts/ through CLAUDE_PLUGIN_ROOT.
      if (!env.CLAUDE_PLUGIN_ROOT && fs.existsSync(path.join(ECC_ROOT, "scripts", "lib", "utils.js"))) {
        env.CLAUDE_PLUGIN_ROOT = ECC_ROOT
      }
      for (const [lock, pm] of Object.entries(lockfiles)) {
        if (fs.existsSync(path.join(worktree, lock))) {
          env.PACKAGE_MANAGER = pm
          break
        }
      }
      const detected = Object.entries(langDetectors)
        .filter(([file]) => fs.existsSync(path.join(worktree, file)))
        .map(([, lang]) => lang)
      if (detected.length > 0) {
        env.DETECTED_LANGUAGES = detected.join(",")
        env.PRIMARY_LANGUAGE = detected[0]
      }
    })

    // Session-idle audit + desktop notification over the public event stream.
    const controller = new AbortController()
    void (async () => {
      for await (const e of ctx.event.subscribe({ signal: controller.signal })) {
        if ((e as { type?: string }).type !== "session.idle") continue
        if (!hookEnabled("stop:check-console-log", ["minimal", "standard", "strict"])) continue
        let total = 0
        const files: string[] = []
        for (const f of editedFiles) {
          if (!/\.(ts|tsx|js|jsx)$/.test(f)) continue
          try {
            const n = fs.readFileSync(f, "utf-8").split("\n").filter((l) => l.includes("console.log")).length
            if (n > 0) {
              total += n
              files.push(f)
            }
          } catch {}
        }
        if (total > 0) {
          log(ctx, "warn", `[ECC] Audit: ${total} console.log statement(s) in ${files.length} file(s): ${files.join(", ")}`)
        } else {
          log(ctx, "info", "[ECC] Audit passed: no console.log statements found")
        }
        try {
          if (process.platform === "linux") {
            void import("child_process").then((cp) => cp.exec?.('notify-send "OpenCode ECC" "Task completed!" 2>/dev/null'))
          }
        } catch {}
        editedFiles.clear()
      }
    })()

    return () => controller.abort()
  },
})
