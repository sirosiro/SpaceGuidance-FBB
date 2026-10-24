#!/bin/bash
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

if [ -f "$SCRIPT_DIR/pilot.py" ]; then
    PILOT_SCRIPT="$SCRIPT_DIR/pilot.py"
else
    PILOT_SCRIPT="$PLUGIN_ROOT/examples/mission03_baseline_truss.py"
fi

DAEMON_PID=""
PILOT_PID=""

cleanup() {
    trap - EXIT INT TERM
    if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
        kill -9 "$DAEMON_PID" 2>/dev/null || true
    fi
    if [ -n "$PILOT_PID" ] && kill -0 "$PILOT_PID" 2>/dev/null; then
        kill -9 "$PILOT_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

if [ "$FBB_ACTIVE" = "1" ]; then
    echo "[SpaceGuidance] F-BB Lab environment active (Stage 3: ISS Truss Inspector)."
    # Clean up any leftover stale processes before launching our own
    pkill -9 -f "space_guidance_daemon" 2>/dev/null || true
    pkill -9 -f "pilot.py" 2>/dev/null || true
    pkill -9 -f "mission03_baseline_truss.py" 2>/dev/null || true
    sleep 0.2

    rm -f /dev/shm/fbb_space_guidance_shm /tmp/fbb_space_guidance_shm /tmp/space_guidance_telemetry.json
    # Auto-build space_guidance_daemon if missing (e.g. after clean.sh)
    if [ ! -f "$PLUGIN_ROOT/bin/space_guidance_daemon" ]; then
        echo "[SpaceGuidance] Binary space_guidance_daemon not found. Auto-building via CMake..."
        cmake -B "$PLUGIN_ROOT/build" -S "$PLUGIN_ROOT" >/dev/null 2>&1
        cmake --build "$PLUGIN_ROOT/build" >/dev/null 2>&1
        if [ ! -f "$PLUGIN_ROOT/bin/space_guidance_daemon" ]; then
            echo "[SpaceGuidance Error] Failed to build space_guidance_daemon!"
            exit 1
        fi
        echo "[SpaceGuidance] Build complete."
    fi
    echo "[SpaceGuidance] Launching physics daemon in background with Stage 3..."
    export SPACE_GUIDANCE_STAGE=3
    ( unset LD_PRELOAD; exec "$PLUGIN_ROOT/bin/space_guidance_daemon" --stage 3 ) &
    DAEMON_PID=$!
    sleep 0.5
    if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
        echo "[SpaceGuidance Error] space_guidance_daemon failed to start or terminated unexpectedly!"
        exit 1
    fi

    echo "[SpaceGuidance] Launching Stage 3 Python Autopilot ($PILOT_SCRIPT)..."
    python3 "$PILOT_SCRIPT" "$@" &
    PILOT_PID=$!
    wait $PILOT_PID 2>/dev/null || true
    echo "[SpaceGuidance] Stage 3 Autopilot finished. Terminating physics daemon."
    cleanup
else
    bash "$SCRIPT_DIR/run_mission.sh" "$@"
fi
