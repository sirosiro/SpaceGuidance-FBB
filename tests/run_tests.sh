#!/bin/bash
# ==============================================================================
# SpaceGuidance-FBB: Unified Master Test Runner
# ==============================================================================
# Executes all C++/Verilator co-sim tests and all 5 Stage Python autopilot tests.
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

echo "=========================================================="
echo "  🛰️  SpaceGuidance-FBB Master Automated Test Suite"
echo "=========================================================="
echo "  Project Root: ${PROJECT_ROOT}"
echo "=========================================================="

FAILED_TESTS=()
PASSED_TESTS=()

run_step() {
    local name="$1"
    shift
    echo -e "\n----------------------------------------------------------"
    echo "  ▶ RUNNING: ${name}"
    echo "----------------------------------------------------------"
    if "$@"; then
        echo "  ✅ PASS: ${name}"
        PASSED_TESTS+=("${name}")
    else
        echo "  ❌ FAIL: ${name}"
        FAILED_TESTS+=("${name}")
    fi
}

# 1. Auto-build space_guidance_daemon
echo "[Build] Ensuring space_guidance_daemon is up to date..."
cmake -B "${PROJECT_ROOT}/build" -S "${PROJECT_ROOT}" >/dev/null 2>&1
cmake --build "${PROJECT_ROOT}/build" >/dev/null 2>&1

# 2. Build and run Verilator RTL test
echo "[Build] Building Verilator RTL Test..."
verilator -Wall -Wno-fatal --cc \
    rtl/space_guidance_top.v \
    rtl/line_sensor_filter.v \
    rtl/rcs_thruster_pwm.v \
    rtl/safety_interlock.v \
    --exe tests/test_rtl_top.cpp \
    -Mdir obj_dir_rtl --build -o test_rtl_top >/dev/null 2>&1

run_step "Verilator RTL 8-Point Unit Test" "${PROJECT_ROOT}/obj_dir_rtl/test_rtl_top"

# 3. Build and run Verilator Physics Co-Sim test
echo "[Build] Building Verilator Physics Co-Sim Test..."
verilator -Wall -Wno-fatal --cc \
    rtl/space_guidance_top.v \
    rtl/line_sensor_filter.v \
    rtl/rcs_thruster_pwm.v \
    rtl/safety_interlock.v \
    --exe tests/test_physics_sim.cpp \
    src/space_physics.cpp \
    -CFLAGS "-I../include" \
    -Mdir obj_dir_physics --build -o test_physics_sim >/dev/null 2>&1

run_step "Physics & RTL Co-Sim Closed-Loop Test" "${PROJECT_ROOT}/obj_dir_physics/test_physics_sim"

# 4. Stage 1 Asteroid Pipeline Integration Test
run_step "Stage 1: Asteroid Pipeline Integration Test" python3 "${PROJECT_ROOT}/tests/test_stage1_run.py"

# 5. Stage 2 Tether Climber Integration Test
run_step "Stage 2: Tether Climber Integration Test" python3 "${PROJECT_ROOT}/tests/test_stage2_run.py"

# 6. Stage 3 ISS Truss Flaw Inspector Integration Test
run_step "Stage 3: ISS Truss Inspector Integration Test" python3 "${PROJECT_ROOT}/tests/test_stage3_run.py"

# 7. Stage 4 Laser Docking Integration Test
run_step "Stage 4: Optical Laser Docking Integration Test" python3 "${PROJECT_ROOT}/tests/test_stage4_run.py"

# 8. Stage 5 Panic Control Integration Test
run_step "Stage 5: Panic Control Debris Escape Test" python3 "${PROJECT_ROOT}/tests/test_panic_control.py"

echo -e "\n=========================================================="
echo "  🏆 Master Test Suite Execution Summary"
echo "=========================================================="
echo "  Passed: ${#PASSED_TESTS[@]} / $(( ${#PASSED_TESTS[@]} + ${#FAILED_TESTS[@]} ))"
for p in "${PASSED_TESTS[@]}"; do
    echo "    ✓ ${p}"
done

if [ ${#FAILED_TESTS[@]} -ne 0 ]; then
    echo "  Failed: ${#FAILED_TESTS[@]}"
    for f in "${FAILED_TESTS[@]}"; do
        echo "    ✗ ${f}"
    done
    exit 1
fi

echo "=========================================================="
echo "✨ ALL TESTS COMPLETED WITH 100% PASS!"
echo "=========================================================="
