#!/bin/bash
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

DAEMON_BIN="$PLUGIN_ROOT/bin/space_guidance_daemon"
PILOT_SCRIPT="$SCRIPT_DIR/pilot.py"

cleanup() {
    kill $DAEMON_PID $PILOT_PID 2>/dev/null || true
    pkill -9 -f "space_guidance_daemon" 2>/dev/null || true
    pkill -9 -f "pilot.py" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "============================================================"
echo "  SpaceGuidance-FBB: Stage EX Panic Control Challenge       "
echo "  (Debris Collision, High Tumbling Spin & Thruster Damage)  "
echo "============================================================"

rm -f /tmp/fbb_space_guidance_shm /tmp/space_guidance_telemetry.json

echo "[Stage EX Launcher] Launching physics daemon (Stage 5)..."
export SPACE_GUIDANCE_STAGE=5
"$DAEMON_BIN" --stage 5 "$@" &
DAEMON_PID=$!
sleep 0.5

echo "[Stage EX Launcher] Launching Stage EX Python Autopilot ($PILOT_SCRIPT)..."
python3 "$PILOT_SCRIPT" "$@"
PILOT_EXIT=$?

cleanup
exit $PILOT_EXIT
