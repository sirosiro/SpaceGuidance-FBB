#!/bin/bash
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

if [ -f "$SCRIPT_DIR/pilot.py" ]; then
    PILOT_SCRIPT="$SCRIPT_DIR/pilot.py"
else
    PILOT_SCRIPT="$PLUGIN_ROOT/examples/mission03_baseline_truss.py"
fi

cleanup() {
    kill $DAEMON_PID $PILOT_PID 2>/dev/null || true
    pkill -9 -f "space_guidance_daemon" 2>/dev/null || true
    pkill -9 -f "pilot.py" 2>/dev/null || true
    pkill -9 -f "mission03_baseline_truss.py" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ "$FBB_ACTIVE" = "1" ]; then
    echo "[SpaceGuidance] F-BB Lab environment active (Stage 3: ISS Truss Inspector)."
    cleanup
    rm -f /tmp/fbb_space_guidance_shm /tmp/space_guidance_telemetry.json
    echo "[SpaceGuidance] Launching physics daemon in background with Stage 3..."
    export SPACE_GUIDANCE_STAGE=3
    "$PLUGIN_ROOT/bin/space_guidance_daemon" --stage 3 &
    DAEMON_PID=$!
    sleep 0.5

    echo "[SpaceGuidance] Launching Stage 3 Python Autopilot ($PILOT_SCRIPT)..."
    python3 "$PILOT_SCRIPT" "$@" &
    PILOT_PID=$!
    wait $PILOT_PID 2>/dev/null || true
    echo "[SpaceGuidance] Stage 3 Autopilot finished. Terminating physics daemon."
    cleanup
else
    bash "$SCRIPT_DIR/run_mission.sh" "$@"
fi
