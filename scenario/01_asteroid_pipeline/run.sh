#!/bin/bash
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

if [ "$FBB_ACTIVE" = "1" ]; then
    echo "[SpaceGuidance] F-BB Lab environment active."
    pkill -9 -f space_guidance_daemon 2>/dev/null || true
    rm -f /tmp/fbb_space_guidance_shm /tmp/space_guidance_telemetry.json
    echo "[SpaceGuidance] Launching physics daemon in background..."
    "$PLUGIN_ROOT/bin/space_guidance_daemon" &
    DAEMON_PID=$!
    trap "kill $DAEMON_PID 2>/dev/null || true" EXIT INT TERM
    sleep 0.5

    echo "[SpaceGuidance] Launching Stage 1 Python Autopilot..."
    python3 "$PLUGIN_ROOT/examples/mission01_baseline_pilot.py" "$@"
    echo "[SpaceGuidance] Autopilot finished. Terminating physics daemon."
    kill $DAEMON_PID 2>/dev/null || true
else
    bash "$PLUGIN_ROOT/scenario/01_asteroid_pipeline/run_mission.sh" "$@"
fi
