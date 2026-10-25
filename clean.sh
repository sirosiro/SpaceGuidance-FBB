#!/bin/bash
# ==============================================================================
# SpaceGuidance-FBB: Clean Script
# ==============================================================================
# Cleans all build artifacts, Verilator models, compiled binaries,
# test executables, logs, waveforms, and Python caches.
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

echo "[SpaceGuidance] Stopping background processes..."
pkill -f "space_guidance_daemon" 2>/dev/null || true
pkill -f "pilot.py" 2>/dev/null || true

echo "[SpaceGuidance] Cleaning build artifacts and binaries..."
# Build directory
if [ -d "build" ]; then
    rm -rf build/*
fi

# Bin directory (daemon executable)
if [ -d "bin" ]; then
    rm -rf bin/*
fi

# Verilator output directories
rm -rf obj_dir obj_dir_rtl obj_dir_physics

# Scenario & test binaries
rm -f scenario/*/test_bin
rm -f tests/test_bin
rm -f test_bin

# Logs and VCD waveforms
rm -f *.log scenario/*/*.log tests/*.log 2>/dev/null || true
rm -f *.vcd scenario/*/*.vcd tests/*.vcd 2>/dev/null || true

# Python caches
find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find . -type f -name "*.pyc" -delete 2>/dev/null || true
find . -type f -name "*.pyo" -delete 2>/dev/null || true

# Temporary IPC / SHM / Telemetry files
rm -f /dev/shm/fbb_space_guidance_shm 2>/dev/null || true
rm -f /tmp/fbb_space_guidance_shm 2>/dev/null || true
rm -f /tmp/space_guidance_telemetry.json 2>/dev/null || true
rm -f /tmp/fbb_scenario_telemetry.json 2>/dev/null || true
rm -f /tmp/fbb_scenario_telemetry.json.tmp 2>/dev/null || true

echo "[SpaceGuidance] Clean finished successfully."
