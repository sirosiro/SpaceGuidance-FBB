#!/bin/bash
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

if [ -f "$SCRIPT_DIR/pilot.py" ]; then
    PILOT_SCRIPT="$SCRIPT_DIR/pilot.py"
else
    PILOT_SCRIPT="$PLUGIN_ROOT/examples/mission05_baseline_panic.py"
fi

cleanup() {
    kill $DAEMON_PID $PILOT_PID 2>/dev/null || true
    pkill -9 -f "space_guidance_daemon" 2>/dev/null || true
    pkill -9 -f "pilot.py" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ "$FBB_ACTIVE" = "1" ]; then
    echo "[SpaceGuidance] F-BB Lab environment active (Stage EX)."
    cleanup
    rm -f /dev/shm/fbb_space_guidance_shm /tmp/fbb_space_guidance_shm /tmp/space_guidance_telemetry.json
    if [ ! -f "$PLUGIN_ROOT/bin/space_guidance_daemon" ]; then
        echo "[SpaceGuidance] Binary space_guidance_daemon not found. Auto-building via CMake..."
        cmake -B "$PLUGIN_ROOT/build" -S "$PLUGIN_ROOT" >/dev/null 2>&1
        cmake --build "$PLUGIN_ROOT/build" >/dev/null 2>&1
    fi
    echo "[SpaceGuidance] Launching Stage 5 physics daemon in background..."
    export SPACE_GUIDANCE_STAGE=5
    ( unset LD_PRELOAD; "$PLUGIN_ROOT/bin/space_guidance_daemon" --stage 5 "$@" ) &
    DAEMON_PID=$!
    sleep 0.5

    echo "[SpaceGuidance] Launching Stage EX Python Autopilot ($PILOT_SCRIPT)..."
    python3 "$PILOT_SCRIPT" "$@" &
    PILOT_PID=$!
    wait $PILOT_PID 2>/dev/null || true
    cleanup
else
    bash "$SCRIPT_DIR/run_mission.sh" "$@"
fi
