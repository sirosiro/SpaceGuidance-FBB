#!/bin/bash
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

cleanup() {
    kill $DAEMON_PID $PILOT_PID 2>/dev/null || true
    pkill -9 -f "space_guidance_daemon" 2>/dev/null || true
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

    echo "[SpaceGuidance] Launching Stage 1 Python Autopilot..."
    python3 "$PLUGIN_ROOT/examples/mission01_baseline_pilot.py" "$@" &
    PILOT_PID=$!
    wait $PILOT_PID 2>/dev/null || true
    echo "[SpaceGuidance] Autopilot finished. Terminating physics daemon."
    cleanup
else
    bash "$PLUGIN_ROOT/scenario/01_asteroid_pipeline/run_mission.sh" "$@"
fi
