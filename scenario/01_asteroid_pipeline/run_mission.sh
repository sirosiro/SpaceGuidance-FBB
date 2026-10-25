#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"

# Priority: scenario-local pilot.py, fallback: examples/mission01_baseline_pilot.py
if [ -f "$DIR/pilot.py" ]; then
    PILOT_SCRIPT="$DIR/pilot.py"
else
    PILOT_SCRIPT="$ROOT/examples/mission01_baseline_pilot.py"
fi

echo "=========================================================="
echo "  SpaceGuidance-FBB: Stage 1 Asteroid Pipeline Challenge  "
echo "=========================================================="

pkill -9 -f space_guidance_daemon 2>/dev/null || true
pkill -9 -f "pilot.py" 2>/dev/null || true
pkill -9 -f "mission01_baseline_pilot.py" 2>/dev/null || true
rm -f /dev/shm/fbb_space_guidance_shm /tmp/fbb_space_guidance_shm /tmp/space_guidance_telemetry.json /tmp/fbb_scenario_telemetry.json

echo "[1/2] Starting Simulation Daemon..."
"$ROOT/bin/space_guidance_daemon" &
DAEMON_PID=$!

trap "echo '[Cleaning up daemon]'; kill -SIGINT $DAEMON_PID 2>/dev/null || true" EXIT

sleep 0.5

echo "[2/2] Launching Autopilot ($PILOT_SCRIPT)..."
python3 "$PILOT_SCRIPT" "$@"

echo "Mission Completed."
