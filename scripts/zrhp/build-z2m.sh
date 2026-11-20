#!/usr/bin/env bash
# Build Zigbee2MQTT with the ZRHP zigbee-herdsman fork (faronov/zigbee-herdsman, branch `zrhp`).
#
#   scripts/zrhp/build-z2m.sh [DEST]          # default DEST: ./zigbee2mqtt-zrhp
#
# Environment:
#   Z2M_REF         Zigbee2MQTT tag or branch            (default: 2.14.3)
#   HERDSMAN_REPO   herdsman fork URL                     (default: https://github.com/faronov/zigbee-herdsman.git)
#   HERDSMAN_REF    branch, tag or commit of the fork     (default: zrhp)
#   HERDSMAN_DIR    use this local herdsman checkout instead of cloning (built in place)
#
# Needs git, Node.js 22 or 24, corepack (ships with Node.js) and a C/C++ toolchain for the serial port binding.
# The result is a normal Zigbee2MQTT checkout: `cd DEST && ZIGBEE2MQTT_DATA=/path/to/data node index.js`.
set -euo pipefail

Z2M_REF="${Z2M_REF:-2.14.3}"
HERDSMAN_REPO="${HERDSMAN_REPO:-https://github.com/faronov/zigbee-herdsman.git}"
HERDSMAN_REF="${HERDSMAN_REF:-zrhp}"
DEST="${1:-./zigbee2mqtt-zrhp}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export CI=true
PNPM="${PNPM:-corepack pnpm}"

echo "==> zigbee-herdsman ($HERDSMAN_REF)"
if [[ -n "${HERDSMAN_DIR:-}" ]]; then
    HERDSMAN="$(cd "$HERDSMAN_DIR" && pwd)"
else
    HERDSMAN="$WORK/zigbee-herdsman"
    git clone --quiet "$HERDSMAN_REPO" "$HERDSMAN"
    git -C "$HERDSMAN" checkout --quiet "$HERDSMAN_REF"
fi
(
    cd "$HERDSMAN"
    $PNPM install --frozen-lockfile
    $PNPM run build
    $PNPM pack --pack-destination "$WORK" >/dev/null
)
TGZ="$(ls "$WORK"/zigbee-herdsman-*.tgz)"
echo "    $(basename "$TGZ") ($(git -C "$HERDSMAN" rev-parse --short HEAD 2>/dev/null || echo local))"

echo "==> Zigbee2MQTT ($Z2M_REF) -> $DEST"
if [[ ! -d "$DEST/.git" ]]; then
    git clone --quiet --depth 1 --branch "$Z2M_REF" https://github.com/Koenkk/zigbee2mqtt.git "$DEST"
fi
mkdir -p "$DEST/.zrhp"
cp "$TGZ" "$DEST/.zrhp/zigbee-herdsman.tgz"
cd "$DEST"

# 1. every zigbee-herdsman in the tree (Zigbee2MQTT's and zigbee-herdsman-converters') becomes the fork
# 2. `serial.adapter: zrhp` is allowed by the settings schema
node - <<'EOF'
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.dependencies["zigbee-herdsman"] = "file:.zrhp/zigbee-herdsman.tgz";
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 4)}\n`);
let ws = fs.readFileSync("pnpm-workspace.yaml", "utf8");
if (!/^overrides:/m.test(ws)) {
    ws += "\noverrides:\n  zigbee-herdsman: file:.zrhp/zigbee-herdsman.tgz\n";
}
fs.writeFileSync("pnpm-workspace.yaml", ws);
const schemaPath = "lib/util/settings.schema.json";
const text = fs.readFileSync(schemaPath, "utf8");
const patched = text.replace(/("enum":\s*\[\s*"deconz",[^\]]*?"zoh")(\s*\])/, (_m, a, b) => (a.includes('"zrhp"') ? a : `${a}, "zrhp"`) + b);
if (!patched.includes('"zrhp"')) {
    throw new Error("could not add zrhp to the adapter enum of settings.schema.json");
}
fs.writeFileSync(schemaPath, patched);
EOF

$PNPM install --no-frozen-lockfile
$PNPM run build
node -e '
const fs = require("node:fs");
const main = require.resolve("zigbee-herdsman");
const zrhp = main.replace(/index\.js$/, "adapter/zrhp/adapter/zrhpAdapter.js");
if (!fs.existsSync(zrhp)) { console.error("zigbee-herdsman in this tree has no ZRHP adapter"); process.exit(1); }
console.log(`    Zigbee2MQTT ${require("./package.json").version} with zigbee-herdsman ${require("zigbee-herdsman/package.json").version} (ZRHP adapter present)`);
'
echo "==> done. Start with:  cd $DEST && ZIGBEE2MQTT_DATA=/path/to/data node index.js"
