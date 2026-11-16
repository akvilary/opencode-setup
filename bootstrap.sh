#!/usr/bin/env bash
# Idempotent OpenCode + ECC setup (Linux/macOS).
# Safe to re-run: updates ECC, then reapplies this overlay on top.
#
#   git clone https://github.com/akvilary/opencode-setup.git
#   cd opencode-setup && ./bootstrap.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
ECC_DIR="$HOME/.local/share/ecc"
CFG="$HOME/.config/opencode"

log() { printf '\n==> %s\n' "$*"; }

command -v node >/dev/null || { echo "node 18+ required"; exit 1; }
command -v python3 >/dev/null || { echo "python3 required"; exit 1; }

# 1) ECC: clone or update, build the OpenCode plugin payload, install (profile: full, hooks: standard)
log "ECC install/update ($ECC_DIR)"
if [ ! -d "$ECC_DIR/.git" ]; then
  git clone --depth 1 https://github.com/affaan-m/ECC "$ECC_DIR"
else
  git -C "$ECC_DIR" fetch --depth 1 origin main
  git -C "$ECC_DIR" reset --hard FETCH_HEAD
fi
(
  cd "$ECC_DIR"
  npm ci
  node scripts/build-opencode.js
  node scripts/install-apply.js --target opencode --profile full --enable-hooks
)

# 2) V2 plugin SDK (V2 plugins import @opencode/plugin, not the V1 @opencode-ai/plugin)
log "V2 plugin SDK"
( cd "$CFG" && npm install @opencode/plugin@latest )

# 3) Overlay: the V2 hooks shim + custom agents
log "Overlay"
mkdir -p "$CFG/plugins" "$CFG/agents"
cp "$SRC/overlay/plugins/ecc-v2-hooks.ts" "$CFG/plugins/"
cp "$SRC/overlay/agents/"*.md "$CFG/agents/"

# 4) The upstream ECC plugin is V1-only and the V2 loader rejects it; the shim replaces it
log "Remove V1 plugin files (restored by ECC updates — this script removes them again)"
rm -f "$CFG/plugins/ecc-hooks.ts" "$CFG/plugins/index.ts"

# 5) Config fixes over ECC's managed opencode.json (ECC rewrites it on every install — reapplied here)
log "Config fixes (lsp, V2 plugins field, dead instructions)"
python3 - "$CFG" <<'PYEOF'
import json, os, sys
cfg_dir = sys.argv[1]
p = os.path.join(cfg_dir, "opencode.json")
cfg = json.load(open(p))
cfg["lsp"] = True
if "plugin" in cfg:
    cfg["plugins"] = cfg.pop("plugin")
cfg["instructions"] = [
    i for i in cfg.get("instructions", [])
    if os.path.exists(os.path.join(cfg_dir, i))
]
json.dump(cfg, open(p, "w"), indent=2, ensure_ascii=False)
print("  lsp:", cfg["lsp"], "| plugins:", cfg.get("plugins"), "| instructions:", len(cfg["instructions"]))
PYEOF

# 6) Old jsonc (if migrating a machine that had one) — its content is merged in step 5
[ -f "$CFG/opencode.jsonc" ] && rm -f "$CFG/opencode.jsonc" && echo "  removed opencode.jsonc (merged)"

log "Done. Restart your opencode session (or /reload) and verify:"
echo "  - skills:   314 in ~/.config/opencode/skills"
echo "  - agents:   ECC roster + swift-reviewer in ~/.config/opencode/agents"
echo "  - hooks:    plugin 'ecc-v2-hooks' loads with no WARN in ~/.local/share/opencode/log/opencode.log"
echo "  Hooks profile: ECC_HOOK_PROFILE=minimal|standard|strict, ECC_DISABLED_HOOKS=comma,ids"
