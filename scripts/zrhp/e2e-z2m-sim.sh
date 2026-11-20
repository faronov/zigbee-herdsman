#!/usr/bin/env bash
# End-to-end smoke test: Zigbee2MQTT with the ZRHP adapter on the Rust NCP simulator (zigbee-rs `ncp_sim`) over a PTY.
#
#   scripts/zrhp/e2e-z2m-sim.sh dir:<zigbee2mqtt checkout from build-z2m.sh> <ncp_sim binary>
#   scripts/zrhp/e2e-z2m-sim.sh docker:<image>                                <ncp_sim binary>
#
# Needs socat and an MQTT broker on localhost:1883 (mosquitto + mosquitto-clients). Checks that Zigbee2MQTT starts on the
# NCP, forms the network, writes coordinator_backup.json with stack_specific.zigbee_rs, and answers a permit-join request.
set -euo pipefail

MODE="$1"
SIM="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
DATA="$(mktemp -d)"
chmod 777 "$DATA"
LOG="$DATA/z2m.log"
PIDS=()
cleanup() {
    for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
    if [[ "$MODE" == docker:* ]]; then docker rm -f zrhp-e2e >/dev/null 2>&1 || true; fi
    echo "---- Zigbee2MQTT log (tail) ----"; tail -n 80 "$LOG" 2>/dev/null || true
    echo "---- ncp_sim stderr (tail) ----"; tail -n 20 "$DATA/ncp_sim.log" 2>/dev/null || true
}
trap cleanup EXIT

if [[ "$MODE" == docker:* ]]; then PORT=/app/data/ttyZRHP; else PORT="$DATA/ttyZRHP"; fi
cat >"$DATA/configuration.yaml" <<EOF
version: 5
homeassistant:
  enabled: false
frontend:
  enabled: false
mqtt:
  base_topic: zigbee2mqtt
  server: mqtt://localhost:1883
serial:
  port: $PORT
  adapter: zrhp
advanced:
  log_level: debug
  log_output: [console]
  channel: 15
  network_key: GENERATE
  pan_id: GENERATE
  ext_pan_id: GENERATE
EOF

# 1. the probe (read-only) on its own simulator instance
socat -d "PTY,link=$DATA/ttyProbe,raw,echo=0,wait-slave,mode=666" "EXEC:$SIM,stderr" 2>"$DATA/probe_sim.log" &
PIDS+=($!)
for _ in $(seq 50); do [[ -e "$DATA/ttyProbe" ]] && break; sleep 0.1; done
if [[ "$MODE" == docker:* ]]; then
    docker run --rm --privileged -v /dev/pts:/dev/pts -v "$DATA:/app/data" "${MODE#docker:}" node .zrhp/probe.js /app/data/ttyProbe
else
    (cd "${MODE#dir:}" && node .zrhp/probe.js "$DATA/ttyProbe")
fi

# 2. Zigbee2MQTT
socat -d "PTY,link=$DATA/ttyZRHP,raw,echo=0,wait-slave,mode=666" "EXEC:$SIM,stderr" 2>"$DATA/ncp_sim.log" &
PIDS+=($!)
for _ in $(seq 50); do [[ -e "$DATA/ttyZRHP" ]] && break; sleep 0.1; done

if [[ "$MODE" == docker:* ]]; then
    docker run -d --name zrhp-e2e --network host --privileged -v /dev/pts:/dev/pts -v "$DATA:/app/data" "${MODE#docker:}" >/dev/null
    docker logs -f zrhp-e2e >"$LOG" 2>&1 &
    PIDS+=($!)
else
    (cd "${MODE#dir:}" && ZIGBEE2MQTT_DATA="$DATA" exec node index.js) >"$LOG" 2>&1 &
    PIDS+=($!)
fi

echo "waiting for Zigbee2MQTT to start..."
for _ in $(seq 180); do
    grep -q "Zigbee2MQTT started" "$LOG" 2>/dev/null && break
    if grep -qE "Failed to start|Error while starting" "$LOG" 2>/dev/null; then echo "Zigbee2MQTT failed to start"; exit 1; fi
    sleep 1
done
grep -q "Zigbee2MQTT started" "$LOG" || { echo "Zigbee2MQTT did not start"; exit 1; }
grep -q "ZRHP session ready" "$LOG" || { echo "no ZRHP session in the log"; exit 1; }

for _ in $(seq 30); do [[ -s "$DATA/coordinator_backup.json" ]] && break; sleep 1; done
node -e '
const b = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const zrs = b.stack_specific && b.stack_specific.zigbee_rs;
if (!zrs || zrs.version !== 1) { console.error("coordinator_backup.json has no stack_specific.zigbee_rs"); process.exit(1); }
console.log(`backup ok: PAN ${b.pan_id}, channel ${b.channel}, NWK limit ${zrs.nwk_frame_counter_limit}, APS limit ${zrs.aps_frame_counter_limit}`);
' "$DATA/coordinator_backup.json"

mosquitto_sub -h localhost -t zigbee2mqtt/bridge/response/permit_join -C 1 -W 30 >"$DATA/permit.json" &
SUB=$!
sleep 1
mosquitto_pub -h localhost -t zigbee2mqtt/bridge/request/permit_join -m '{"time": 20}'
wait "$SUB"
cat "$DATA/permit.json"
grep -q '"status":"ok"' "$DATA/permit.json" || { echo "permit_join failed"; exit 1; }
echo "E2E OK"
