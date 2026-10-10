#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"

echo "=========================================================="
echo "  SpaceGuidance-FBB: Stage 1 Asteroid Pipeline Challenge  "
echo "=========================================================="

pkill -9 -f space_guidance_daemon 2>/dev/null || true
rm -f /tmp/fbb_space_guidance_shm /tmp/space_guidance_telemetry.json

echo "[1/2] Starting Simulation Daemon..."
"$ROOT/bin/space_guidance_daemon" &
DAEMON_PID=$!

trap "echo '[Cleaning up daemon]'; kill -SIGINT $DAEMON_PID 2>/dev/null || true" EXIT

sleep 0.5

echo "[2/2] Launching Baseline Pilot..."
python3 "$ROOT/examples/mission01_baseline_pilot.py"

echo "Mission Completed."
