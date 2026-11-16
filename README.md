# opencode-setup

My [OpenCode](https://opencode.ai/v2/docs/) global configuration overlay on top of
[ECC (Everything Claude Code)](https://github.com/affaan-m/ECC): agents, skills,
commands, and a V2-native hooks shim. One command reproduces the setup on any
Linux/macOS machine.

## What it sets up

| Layer | What |
| --- | --- |
| ECC full profile | 314 skills, 26 agents, 104 commands, curated instructions, `default_agent: build` — installed into `~/.config/opencode` (global, all projects) |
| **`overlay/plugins/ecc-v2-hooks.ts`** | ECC's upstream plugin is written against the V1 OpenCode plugin API and the V2 loader rejects it. This shim implements the same STANDARD-profile hooks natively on V2: console.log warning after JS/TS edits, "is this doc necessary" warning, `gh pr create` log, session-idle console.log audit + desktop notification, shell env injection (`PROJECT_ROOT`, `PACKAGE_MANAGER`, `DETECTED_LANGUAGES`, `CLAUDE_PLUGIN_ROOT` — ECC commands resolve their scripts through it) |
| **`overlay/agents/swift-reviewer.md`** | Read-only Swift reviewer agent (Swift 6 strict concurrency, Sendable/actor isolation, ARC, value semantics, SwiftUI, performance, testing) — ECC ships domain reviewers for other languages but not Swift |
| Config fixes | `lsp: true` merged in, V1 `plugin` field → V2 `plugins`, dead instruction paths dropped, V1 plugin files removed |

Controls: `ECC_HOOK_PROFILE=minimal|standard|strict`, `ECC_DISABLED_HOOKS=comma,ids`.
Deliberately not ported from ECC: prettier auto-format and tsc checks (their
STRICT profile), skill-run telemetry.

## Install (new machine)

```bash
git clone https://github.com/akvilary/opencode-setup.git
cd opencode-setup && ./bootstrap.sh
```

Requires: node 18+, python3, git. Then start a fresh opencode session (or `/reload`).

## Update (re-run any time — idempotent)

```bash
cd ~/dev/apps/opencode-setup && git pull && ./bootstrap.sh
```

The script updates ECC to upstream `main`, reinstalls, and reapplies this
overlay: ECC rewrites its managed `opencode.json` and restores its V1 plugin
files on every install — the overlay puts our fixes back on top.

## Why a separate repo and not an ECC fork

The customizations are an overlay over `~/.config/opencode`, not changes to
ECC's sources. ECC releases weekly; a fork branch would be a permanent merge
burden, while this overlay survives upstream changes as-is.

## Rollback

```bash
node ~/.local/share/ecc/scripts/uninstall.js --target opencode   # removes ECC
rm -f ~/.config/opencode/plugins/ecc-v2-hooks.ts                 # removes the shim
rm -f ~/.config/opencode/agents/swift-reviewer.md                # removes the agent
```
