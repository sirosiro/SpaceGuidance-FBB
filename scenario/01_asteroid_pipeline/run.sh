#!/bin/bash
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

# Priority: scenario-local pilot.py, fallback: examples/mission01_baseline_pilot.py
if [ -f "$SCRIPT_DIR/pilot.py" ]; then
    PILOT_SCRIPT="$SCRIPT_DIR/pilot.py"
else
    PILOT_SCRIPT="$PLUGIN_ROOT/examples/mission01_baseline_pilot.py"
fi

cleanup() {
    kill $DAEMON_PID $PILOT_PID 2>/dev/null || true
    pkill -9 -f "space_guidance_daemon" 2>/dev/null || true
    pkill -9 -f "pilot.py" 2>/dev/null || true
    pkill -9 -f "mission01_baseline_pilot.py" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ "$FBB_ACTIVE" = "1" ]; then
    echo "[SpaceGuidance] F-BB Lab environment active."
    cleanup
    rm -f /tmp/fbb_space_guidance_shm /tmp/space_guidance_telemetry.json
    echo "[SpaceGuidance] Launching physics daemon in background..."
    "$PLUGIN_ROOT/bin/space_guidance_daemon" &
    DAEMON_PID=$!
    sleep 0.5

    echo "[SpaceGuidance] Launching Stage 1 Python Autopilot ($PILOT_SCRIPT)..."
    python3 "$PILOT_SCRIPT" "$@" &
    PILOT_PID=$!
    wait $PILOT_PID 2>/dev/null || true
    echo "[SpaceGuidance] Autopilot finished. Terminating physics daemon."
    cleanup
else
    bash "$SCRIPT_DIR/run_mission.sh" "$@"
fi
