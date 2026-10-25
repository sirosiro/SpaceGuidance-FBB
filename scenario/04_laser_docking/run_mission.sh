#!/bin/bash
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

DAEMON_BIN="$PLUGIN_ROOT/bin/space_guidance_daemon"
PILOT_SCRIPT="$SCRIPT_DIR/pilot.py"

cleanup() {
    kill $DAEMON_PID $PILOT_PID 2>/dev/null || true
    pkill -9 -f "space_guidance_daemon" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "============================================================"
echo "  SpaceGuidance-FBB: Stage 4 Laser Docking Challenge"
echo "============================================================"

rm -f /dev/shm/fbb_space_guidance_shm /tmp/fbb_space_guidance_shm /tmp/space_guidance_telemetry.json /tmp/fbb_scenario_telemetry.json

echo "[Stage 4 Launcher] Launching physics daemon (Stage 4)..."
export SPACE_GUIDANCE_STAGE=4
"$DAEMON_BIN" --stage 4 &
DAEMON_PID=$!
sleep 0.5

echo "[Stage 4 Launcher] Launching Stage 4 Python Autopilot..."
python3 "$PILOT_SCRIPT"
PILOT_EXIT=$?

cleanup
exit $PILOT_EXIT
