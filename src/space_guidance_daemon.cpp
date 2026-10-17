#include <cstring>
#include <iostream>
#include <fstream>
#include <chrono>
#include <thread>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <random>
#include "space_physics.hpp"

// Shared memory layout for F-BB / UIO simulation
struct ShmSpaceGuidance {
    uint32_t cr_ctrl;          // 0x00
    uint32_t sr_status;        // 0x04
    uint32_t sensor_raw;       // 0x08
    uint32_t sensor_edge;      // 0x0C
    uint32_t thrust_cmd_x;     // 0x10
    uint32_t thrust_cmd_y;     // 0x14
    uint32_t thrust_cmd_z;     // 0x18
    uint32_t torque_cmd;       // 0x1C
    uint32_t safety_limit;     // 0x20
    uint32_t watchdog_kick;    // 0x24
    uint32_t chaos_fault_inj;  // 0x28
    uint32_t wheel_torque_cmd; // 0x2C (Reaction Wheel torque command: Q16.16)

    // Telemetry export for Web UI / DPPA (8-byte aligned)
    double pos_x;              // 0x30
    double pos_y;              // 0x38
    double vel_x;              // 0x40
    double vel_y;              // 0x48
    double angle;              // 0x50
    double omega;              // 0x58
    double fuel;               // 0x60
    double cross_track_err;    // 0x68
    double wheel_rpm;          // 0x70 (Reaction Wheel flywheel speed: RPM)
    uint32_t fdir_mode;        // 0x78
    uint32_t stage_id;         // 0x7C (Active Mission Stage ID: 1, 2, 3, 4)

    // Official Referee & Scoring Engine (Single Source of Truth)
    int32_t official_score;    // 0x80 (Official Score in pts)
    uint32_t passed_gates;     // 0x84 (Count of passed checkpoints)
    uint32_t mission_status;   // 0x88 (0: Active, 1: Complete, 2: Failed)
    uint32_t total_gates;      // 0x8C (Total checkpoints in stage)
};

class OfficialReferee {
public:
    int stage_id = 1;
    int32_t total_score = 0;
    int32_t checkpoint_score = 0;
    int32_t bonus_score = 0;
    int passed_checkpoints = 0;
    int total_checkpoints = 9;
    bool checked[16] = {false};
    bool is_completed = false;
    bool is_failed = false;
    std::string failure_reason = "";
    std::string official_grade = "IN_FLIGHT";
    std::string last_event = "";
    double start_time = 0.0;
    double elapsed_time = 0.0;
    double peak_metric = 0.0;

    void init(int stage, double t_now) {
        stage_id = stage;
        total_score = 0;
        checkpoint_score = 0;
        bonus_score = 0;
        passed_checkpoints = 0;
        for (int i = 0; i < 16; ++i) checked[i] = false;
        is_completed = false;
        is_failed = false;
        failure_reason = "";
        official_grade = "IN_FLIGHT";
        last_event = "[REFEREE] Mission Started (Stage " + std::to_string(stage) + ")";
        start_time = t_now;
        elapsed_time = 0.0;
        peak_metric = 0.0;
        if (stage == 1) total_checkpoints = 9;
        else if (stage == 2) total_checkpoints = 9;
        else if (stage == 3) total_checkpoints = 4;
        else if (stage == 4) total_checkpoints = 7;
        else if (stage == 5) total_checkpoints = 3;
    }

    void update(const SpacecraftState& state, double cross_track_err, uint32_t fdir_mode, double dt, double t_now) {
        if (is_completed || is_failed) return;
        elapsed_time = t_now - start_time;

        if (stage_id == 1) {
            // Stage 1: 9 Gates at 5m, 10m, ..., 45m
            for (int i = 1; i <= 9; ++i) {
                double gx = i * 5.0;
                if (!checked[i] && state.pos.x >= gx) {
                    checked[i] = true;
                    passed_checkpoints++;
                    double dev = std::abs(cross_track_err);
                    int pts = 0;
                    std::string rating;
                    if (dev <= 0.05) { pts = 1000; rating = "PASS [PERFECT]"; }
                    else if (dev <= 0.12) { pts = 800; rating = "PASS [GREAT]  "; }
                    else if (dev <= 0.20) { pts = 500; rating = "PASS [GOOD]   "; }
                    else if (dev <= 0.40) { pts = -300; rating = "CLIP [PENALTY]"; }
                    else { pts = -1000; rating = "MISS [PENALTY]"; }
                    checkpoint_score += pts;
                    total_score = checkpoint_score;
                    char buf[128];
                    snprintf(buf, sizeof(buf), "[GATE %02d] X=%4.1fm | Dev=%5.1fcm | %s %+4d pts | Score: %5d pts",
                             i, gx, dev * 100.0, rating.c_str(), pts, total_score);
                    last_event = buf;
                    std::cout << "[Referee] " << last_event << std::endl;
                }
            }
            if (state.pos.x >= 49.0) {
                is_completed = true;
                int time_bonus = std::max(0, static_cast<int>((50.0 - elapsed_time) * 40.0));
                int fuel_bonus = static_cast<int>(state.fuel * 10.0);
                bonus_score = time_bonus + fuel_bonus;
                total_score = checkpoint_score + bonus_score;
                if (total_score >= 8000) official_grade = "GRADE S (Elite Pilot)";
                else if (total_score >= 6500) official_grade = "GRADE A (Certified)";
                else if (total_score >= 4500) official_grade = "GRADE B (Standard)";
                else official_grade = "GRADE C (Pass)";
                last_event = "[REFEREE COMPLETE] Clear: " + std::to_string(static_cast<int>(elapsed_time)) + "s | Total: " + std::to_string(total_score) + " pts (" + official_grade + ")";
                std::cout << "\n============================================================" << std::endl;
                std::cout << "[Referee] " << last_event << std::endl;
                std::cout << "============================================================\n" << std::endl;
            }
        } else if (stage_id == 2) {
            // Stage 2: 9 Altitude Beacons (10m .. 90m)
            if (state.is_cable_snapped || state.cable_tension > 15000.0) {
                is_failed = true;
                total_score = 0;
                official_grade = "DISQUALIFIED (CABLE RUPTURE)";
                last_event = "[REFEREE FAILURE] Cable Tension Exceeded 15,000N Rupture Limit!";
                std::cout << "[Referee] " << last_event << std::endl;
                return;
            }
            if (state.cable_tension > peak_metric) peak_metric = state.cable_tension;

            for (int i = 1; i <= 9; ++i) {
                double bx = i * 10.0;
                if (!checked[i] && state.pos.x >= bx) {
                    checked[i] = true;
                    passed_checkpoints++;
                    double vib = std::abs(cross_track_err);
                    int pts = 0;
                    std::string rating;
                    if (vib <= 0.02) { pts = 1000; rating = "PERFECT"; }
                    else if (vib <= 0.06) { pts = 800; rating = "GREAT  "; }
                    else if (vib <= 0.12) { pts = 500; rating = "GOOD   "; }
                    else { pts = -200; rating = "SHAKE  "; }
                    checkpoint_score += pts;
                    total_score = checkpoint_score;
                    char buf[128];
                    snprintf(buf, sizeof(buf), "[BEACON %02d] Alt=%4.1fm | Vib=%4.1fcm | Tension=%5.0fN | %s %+4d pts | Score: %5d pts",
                             i, bx, vib * 100.0, state.cable_tension, rating.c_str(), pts, total_score);
                    last_event = buf;
                    std::cout << "[Referee] " << last_event << std::endl;
                }
            }
            if (state.pos.x >= 99.8) {
                is_completed = true;
                int time_bonus = std::max(0, static_cast<int>((55.0 - elapsed_time) * 50.0));
                int stab_bonus = std::max(0, static_cast<int>((15000.0 - peak_metric) * 0.1));
                int batt_bonus = static_cast<int>(state.fuel * 10.0);
                bonus_score = time_bonus + stab_bonus + batt_bonus;
                total_score = checkpoint_score + bonus_score;
                if (total_score >= 8000) official_grade = "GRADE S (Master Climber)";
                else if (total_score >= 6500) official_grade = "GRADE A (Certified)";
                else if (total_score >= 5000) official_grade = "GRADE B (Standard)";
                else official_grade = "GRADE C (Pass)";
                last_event = "[REFEREE COMPLETE] GEO Dock Reached! Clear: " + std::to_string(static_cast<int>(elapsed_time)) + "s | Total: " + std::to_string(total_score) + " pts (" + official_grade + ")";
                std::cout << "\n============================================================" << std::endl;
                std::cout << "[Referee] " << last_event << std::endl;
                std::cout << "============================================================\n" << std::endl;
            }
        } else if (stage_id == 3) {
            // Stage 3: 4 Inspection Joints (15m, 30m, 45m, 60m)
            if (std::abs(cross_track_err) > 300.0) {
                is_failed = true;
                total_score = 0;
                official_grade = "DISQUALIFIED (RAIL DERAILMENT)";
                last_event = "[REFEREE FAILURE] Rail Centrifugal Load Exceeded 300N Limit!";
                std::cout << "[Referee] " << last_event << std::endl;
                return;
            }
            const double joints[] = {15.0, 30.0, 45.0, 60.0};
            for (int i = 0; i < 4; ++i) {
                double jx = joints[i];
                double dj = std::abs(state.pos.x - jx);
                if (!checked[i] && dj <= 0.35 && std::abs(state.vel.x) < 0.35 && fdir_mode == 1) {
                    checked[i] = true;
                    passed_checkpoints++;
                    checkpoint_score += 1500;
                    total_score = checkpoint_score;
                    char buf[128];
                    snprintf(buf, sizeof(buf), "[JOINT %02d] Pos=%4.1fm | Latch Verified | +1500 pts | Score: %5d pts",
                             i + 1, jx, total_score);
                    last_event = buf;
                    std::cout << "[Referee] " << last_event << std::endl;
                }
            }
            if (state.pos.x >= 59.8 && passed_checkpoints >= 4) {
                is_completed = true;
                int time_bonus = std::max(0, static_cast<int>((45.0 - elapsed_time) * 50.0));
                int batt_bonus = static_cast<int>(state.fuel * 10.0);
                bonus_score = time_bonus + batt_bonus;
                total_score = checkpoint_score + bonus_score;
                if (total_score >= 8000) official_grade = "GRADE S (Master Inspector)";
                else if (total_score >= 6500) official_grade = "GRADE A (Certified)";
                else if (total_score >= 5000) official_grade = "GRADE B (Standard)";
                else official_grade = "GRADE C (Pass)";
                last_event = "[REFEREE COMPLETE] Truss Survey Complete! Clear: " + std::to_string(static_cast<int>(elapsed_time)) + "s | Total: " + std::to_string(total_score) + " pts (" + official_grade + ")";
                std::cout << "\n============================================================" << std::endl;
                std::cout << "[Referee] " << last_event << std::endl;
                std::cout << "============================================================\n" << std::endl;
            }
        } else if (stage_id == 4) {
            // Stage 4: 7 Range Checkpoints: 40, 30, 20, 10, 5, 2, 1m
            const double ranges[] = {40.0, 30.0, 20.0, 10.0, 5.0, 2.0, 1.0};
            for (int i = 0; i < 7; ++i) {
                double target_x = 50.0 - ranges[i];
                if (!checked[i] && state.pos.x >= target_x) {
                    checked[i] = true;
                    passed_checkpoints++;
                    double e_cm = std::abs(cross_track_err) * 100.0;
                    int pts = (e_cm < 1.0) ? 1000 : ((e_cm < 3.0) ? 800 : 500);
                    checkpoint_score += pts;
                    total_score = checkpoint_score;
                    char buf[128];
                    snprintf(buf, sizeof(buf), "[RANGE %4.1fm] Align Err=%4.1fcm | Vel=%5.3fm/s | +%4d pts | Score: %5d pts",
                             ranges[i], e_cm, state.vel.x, pts, total_score);
                    last_event = buf;
                    std::cout << "[Referee] " << last_event << std::endl;
                }
            }
            if (50.0 - state.pos.x <= 0.05) {
                is_completed = true;
                bool speed_ok = (state.vel.x >= 0.005 && state.vel.x <= 0.035);
                bool align_ok = (std::abs(cross_track_err) <= 0.02);
                int contact_bonus = (speed_ok && align_ok) ? 3000 : (speed_ok ? 1500 : 500);
                int fuel_bonus = static_cast<int>(state.fuel * 10.0);
                bonus_score = contact_bonus + fuel_bonus;
                total_score = checkpoint_score + bonus_score;
                if (total_score >= 8000) official_grade = "GRADE S (Elite Astronaut)";
                else if (total_score >= 6500) official_grade = "GRADE A (Certified)";
                else if (total_score >= 5000) official_grade = "GRADE B (Standard)";
                else official_grade = "GRADE C (Pass)";
                last_event = "[REFEREE COMPLETE] Port Latch Engaged! Speed=" + std::to_string(state.vel.x) + " | Total: " + std::to_string(total_score) + " pts (" + official_grade + ")";
                std::cout << "\n============================================================" << std::endl;
                std::cout << "[Referee] " << last_event << std::endl;
                std::cout << "============================================================\n" << std::endl;
            }
        } else if (stage_id == 5) {
            // Stage 5: Panic Control (3 Checkpoints / Milestones)
            // Phase 1: Detumble Milestone (|omega| < 0.05 rad/s)
            if (!checked[0] && state.is_detumbled) {
                checked[0] = true;
                passed_checkpoints++;
                int detumble_pts = std::max(0, static_cast<int>((15.0 - state.detumble_time) * 200.0));
                checkpoint_score += detumble_pts;
                total_score = checkpoint_score;
                char buf[128];
                snprintf(buf, sizeof(buf), "[FDIR] Detumble Achieved in %4.2fs! | +%4d pts | Score: %5d pts",
                         state.detumble_time, detumble_pts, total_score);
                last_event = buf;
                std::cout << "[Referee] " << last_event << std::endl;
            }

            // Phase 2: Steady Cruise / SysID verification (X >= 15.0m)
            if (!checked[1] && state.pos.x >= 15.0) {
                checked[1] = true;
                passed_checkpoints++;
                int hold_pts = 1000;
                checkpoint_score += hold_pts;
                total_score = checkpoint_score;
                char buf[128];
                snprintf(buf, sizeof(buf), "[WAYPOINT 15m] Corridor Steady Burn | +%4d pts | Score: %5d pts",
                         hold_pts, total_score);
                last_event = buf;
                std::cout << "[Referee] " << last_event << std::endl;
            }

            // Phase 3: Safe Orbit Escape (X >= 35.0m)
            if (state.pos.x >= 35.0 && !is_completed) {
                is_completed = true;
                passed_checkpoints = 3;
                bool in_gate = (std::abs(state.pos.y) <= 6.0);
                int base_escape = 1500;
                int gate_bonus = in_gate ? 1500 : 0;
                int fuel_bonus = static_cast<int>(state.fuel * 25.0);
                int debris_bonus = (state.debris_hits == 0) ? 1500 : 0;
                bonus_score = base_escape + gate_bonus + fuel_bonus + debris_bonus;
                total_score = checkpoint_score + bonus_score;

                if (total_score >= 8000) official_grade = "GRADE S (Elite Astronaut)";
                else if (total_score >= 6500) official_grade = "GRADE A (Certified)";
                else if (total_score >= 5000) official_grade = "GRADE B (Standard)";
                else official_grade = "GRADE C (Pass)";

                char buf[256];
                snprintf(buf, sizeof(buf), "[REFEREE COMPLETE] Safe Orbit Escaped! Hits=%d | Fuel=%4.1f%% | Total: %5d pts (%s)",
                         state.debris_hits, state.fuel, total_score, official_grade.c_str());
                last_event = buf;
                std::cout << "\n============================================================" << std::endl;
                std::cout << "[Referee] " << last_event << std::endl;
                std::cout << "============================================================\n" << std::endl;
            }

            // Fuel depletion failure
            if (state.fuel <= 0.0 && !is_completed) {
                is_failed = true;
                official_grade = "FAILED (PROPELLANT DEPLETED)";
                last_event = "[REFEREE FAILED] Propellant Depleted in Debris Field!";
                std::cout << "\n============================================================" << std::endl;
                std::cout << "[Referee] " << last_event << std::endl;
                std::cout << "============================================================\n" << std::endl;
            }
        }
    }
};

int main(int argc, char** argv) {
    int stage_id = 1;
    uint32_t chaos_seed = 0;
    bool explicit_seed = false;

    for (int i = 1; i < argc; ++i) {
        if (strncmp(argv[i], "--stage=", 8) == 0) {
            stage_id = atoi(argv[i] + 8);
        } else if (strcmp(argv[i], "--stage") == 0 && i + 1 < argc) {
            stage_id = atoi(argv[++i]);
        } else if (strncmp(argv[i], "--seed=", 7) == 0) {
            chaos_seed = static_cast<uint32_t>(strtoul(argv[i] + 7, nullptr, 0));
            explicit_seed = true;
        } else if (strcmp(argv[i], "--seed") == 0 && i + 1 < argc) {
            chaos_seed = static_cast<uint32_t>(strtoul(argv[++i], nullptr, 0));
            explicit_seed = true;
        }
    }
    if (const char* stage_env = getenv("SPACE_GUIDANCE_STAGE")) {
        stage_id = atoi(stage_env);
    } else if (const char* fbb_stage = getenv("FBB_STAGE")) {
        stage_id = atoi(fbb_stage);
    }

    if (!explicit_seed) {
        if (const char* env_s = getenv("FBB_CHAOS_SEED")) {
            chaos_seed = static_cast<uint32_t>(strtoul(env_s, nullptr, 0));
            explicit_seed = true;
        } else if (const char* env_cs = getenv("CHAOS_SEED")) {
            chaos_seed = static_cast<uint32_t>(strtoul(env_cs, nullptr, 0));
            explicit_seed = true;
        } else {
            std::ifstream sf("/tmp/fbb_chaos_seed.txt");
            if (sf.is_open()) {
                unsigned long long fseed = 0;
                if (sf >> fseed && fseed != 0) {
                    chaos_seed = static_cast<uint32_t>(fseed & 0xFFFFFFFF);
                    explicit_seed = true;
                }
            }
        }
    }

    if (!explicit_seed && stage_id == 5) {
        // True dynamic randomness on every launch!
        std::random_device rd;
        auto now_ns = std::chrono::high_resolution_clock::now().time_since_epoch().count();
        chaos_seed = static_cast<uint32_t>((now_ns ^ (static_cast<uint64_t>(rd()) << 16)) & 0xFFFFFFFF);
        if (chaos_seed == 0 || chaos_seed == 0x1337) chaos_seed = 0x2026;
    }

    std::cout << "[SpaceGuidance Daemon] Initializing simulation daemon for Stage " << stage_id << "..." << std::endl;

    const char* shm_path = "/tmp/vfpga_reg";
    if (const char* env_path = getenv("FBB_SHM_PATH")) {
        shm_path = env_path;
    }

    int fd = open(shm_path, O_RDWR | O_CREAT, 0666);
    if (fd < 0) {
        std::cerr << "Failed to open shared memory file: " << shm_path << std::endl;
        return 1;
    }

    if (ftruncate(fd, 4096) != 0) {
        std::cerr << "Failed to truncate shared memory file" << std::endl;
        close(fd);
        return 1;
    }

    ShmSpaceGuidance* shm = (ShmSpaceGuidance*)mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (shm == MAP_FAILED) {
        std::cerr << "Failed to mmap shared memory" << std::endl;
        close(fd);
        return 1;
    }

    const char* legacy_shm_link = "/tmp/fbb_space_guidance_shm";
    struct stat st;
    if (lstat(legacy_shm_link, &st) == 0) {
        unlink(legacy_shm_link);
    }
    if (symlink(shm_path, legacy_shm_link) != 0) {
        // Ignored
    }

    memset(shm, 0, 4096);

    SpacePhysicsEngine physics(100.0, 25.0, stage_id);
    if (stage_id == 5) {
        physics.set_chaos_seed(chaos_seed);
    }
    std::cout << "[SpaceGuidance Daemon] Ready. Running physics for Stage " << stage_id 
              << " (Chaos Seed: 0x" << std::hex << chaos_seed << std::dec << ") at 100Hz." << std::endl;

    shm->cr_ctrl = 1;
    shm->safety_limit = 0x00010000;
    shm->fuel = 100.0;
    shm->stage_id = stage_id;
    shm->chaos_fault_inj = chaos_seed;
    shm->thrust_cmd_x = 0;
    shm->thrust_cmd_y = 0;
    shm->thrust_cmd_z = 0;
    shm->torque_cmd = 0;
    shm->wheel_torque_cmd = 0;

    auto start_tp = std::chrono::steady_clock::now();
    double t_start_sec = 0.0;
    OfficialReferee referee;
    referee.init(stage_id, t_start_sec);

    {
        std::ofstream jf("/tmp/space_guidance_telemetry.json");
        jf << "{\"stage_id\":" << stage_id 
           << ",\"pos_x\":0.0,\"pos_y\":0.0,\"vel_x\":0.0,\"vel_y\":0.0,\"angle\":0.0,\"omega\":0.0,\"fuel\":100.0,\"cross_track_err\":0.0,\"sensor_raw\":0,\"fdir_mode\":0"
           << ",\"score\":0,\"checkpoint_score\":0,\"bonus_score\":0,\"passed_checkpoints\":0,\"total_checkpoints\":" << referee.total_checkpoints
           << ",\"mission_status\":\"ACTIVE\",\"official_grade\":\"IN_FLIGHT\",\"last_event\":\"[REFEREE] Mission Started\",\"elapsed_time\":0.0}\n";
    }

    int tick_cnt = 0;
    uint32_t current_seed = chaos_seed;
    while (shm->cr_ctrl & 0x01) {
        auto now_tp = std::chrono::steady_clock::now();
        double t_now_sec = std::chrono::duration<double>(now_tp - start_tp).count();

        double fx = static_cast<int32_t>(shm->thrust_cmd_x) / 65536.0 * 50.0;
        double fy = static_cast<int32_t>(shm->thrust_cmd_y) / 65536.0 * 50.0;
        double tau_rcs = static_cast<int32_t>(shm->torque_cmd) / 65536.0 * 20.0;
        double tau_wheel = static_cast<int32_t>(shm->wheel_torque_cmd) / 65536.0 * 20.0;
        uint32_t direct_thruster_mask = shm->thrust_cmd_z;

        if (stage_id == 5 && shm->chaos_fault_inj != 0 && shm->chaos_fault_inj != current_seed) {
            current_seed = shm->chaos_fault_inj;
            physics.set_chaos_seed(current_seed);
            std::cout << "[SpaceGuidance Daemon] Chaos seed dynamically updated to 0x" 
                      << std::hex << current_seed << std::dec << std::endl;
        }

        double tau_x = 0.0;
        double tau_y = 0.0;
        double tau_w_x = 0.0;
        double tau_w_y = 0.0;
        double fz = 0.0;
        if (stage_id == 5) {
            int32_t* ext_cmd = reinterpret_cast<int32_t*>(reinterpret_cast<char*>(shm) + 0x90);
            tau_x   = ext_cmd[0] / 65536.0 * 20.0; // torque_x_cmd
            tau_y   = ext_cmd[1] / 65536.0 * 20.0; // torque_y_cmd
            tau_w_x = ext_cmd[2] / 65536.0 * 20.0; // wheel_torque_x_cmd
            tau_w_y = ext_cmd[3] / 65536.0 * 20.0; // wheel_torque_y_cmd
            fz      = ext_cmd[4] / 65536.0 * 50.0; // thrust_vertical_cmd
        }

        physics.step(fx, fy, tau_rcs, tau_wheel, 0.01, direct_thruster_mask, tau_x, tau_y, tau_w_x, tau_w_y, fz);

        uint32_t adc = physics.compute_sensor_adc();
        shm->sensor_raw = adc;

        if (stage_id == 2) {
            uint32_t mark_cnt = static_cast<uint32_t>(physics.get_state().pos.x);
            shm->sensor_edge = mark_cnt;
        } else if (stage_id == 3) {
            uint32_t joint_mask = 0;
            double px = physics.get_state().pos.x;
            if (px >= 14.5 && px <= 15.5) joint_mask |= 1;
            if (px >= 29.5 && px <= 30.5) joint_mask |= 2;
            if (px >= 44.5 && px <= 45.5) joint_mask |= 4;
            if (px >= 59.5 && px <= 60.5) joint_mask |= 8;
            shm->sensor_edge = (joint_mask << 16) | static_cast<uint16_t>(px * 100.0);
        } else if (stage_id == 4) {
            int32_t offset_q16 = static_cast<int32_t>(physics.get_state().pos.y * 65536.0);
            shm->sensor_edge = static_cast<uint32_t>(offset_q16);
        } else if (stage_id == 5) {
            shm->sensor_edge = physics.get_thruster_health();
        } else {
            uint32_t sum_weights = 0;
            uint32_t weighted_pos = 0;
            for (int i = 0; i < 8; ++i) {
                uint32_t ch = (adc >> (i * 4)) & 0x0F;
                sum_weights += ch;
                weighted_pos += ch * i;
            }
            if (sum_weights > 8) {
                int32_t centroid_q16 = static_cast<int32_t>(((static_cast<uint64_t>(weighted_pos) << 16) / sum_weights) - 229376);
                shm->sensor_edge = static_cast<uint32_t>(centroid_q16);
            } else {
                shm->sensor_edge = 0;
            }
        }

        const auto& state = physics.get_state();
        shm->pos_x = state.pos.x;
        shm->pos_y = state.pos.y;
        shm->vel_x = state.vel.x;
        shm->vel_y = state.vel.y;
        shm->angle = state.angle;
        shm->omega = state.omega;
        shm->fuel  = state.fuel;
        shm->cross_track_err = physics.get_cross_track_error();
        shm->wheel_rpm = state.wheel_rpm;
        shm->stage_id = stage_id;

        // Update Official Referee
        referee.update(state, shm->cross_track_err, shm->fdir_mode, 0.01, t_now_sec);

        shm->official_score = referee.total_score;
        shm->passed_gates = referee.passed_checkpoints;
        shm->mission_status = referee.is_failed ? 2 : (referee.is_completed ? 1 : 0);
        shm->total_gates = referee.total_checkpoints;

        {
            std::ofstream jf("/tmp/space_guidance_telemetry.json.tmp");
            jf << "{"
               << "\"stage_id\":" << stage_id << ","
               << "\"pos_x\":" << state.pos.x << ","
               << "\"pos_y\":" << state.pos.y << ","
               << "\"pos_z\":" << state.pos_z << ","
               << "\"vel_x\":" << state.vel.x << ","
               << "\"vel_y\":" << state.vel.y << ","
               << "\"vel_z\":" << state.vel_z << ","
               << "\"angle\":" << state.angle << ","
               << "\"omega\":" << state.omega << ","
               << "\"roll\":" << state.roll << ","
               << "\"pitch\":" << state.pitch << ","
               << "\"yaw\":" << state.yaw << ","
               << "\"omega_x\":" << state.omega_x << ","
               << "\"omega_y\":" << state.omega_y << ","
               << "\"omega_z\":" << state.omega_z << ","
               << "\"fuel\":" << state.fuel << ","
               << "\"cross_track_err\":" << shm->cross_track_err << ","
               << "\"cable_tension\":" << state.cable_tension << ","
               << "\"cable_vibration\":" << state.cable_vibration << ","
               << "\"cable_snapped\":" << (state.is_cable_snapped ? 1 : 0) << ","
               << "\"sensor_raw\":" << adc << ","
               << "\"sensor_edge\":" << shm->sensor_edge << ","
               << "\"fdir_mode\":" << shm->fdir_mode << ","
               << "\"thrust_x\":" << (static_cast<int32_t>(shm->thrust_cmd_x) / 65536.0) << ","
               << "\"thrust_y\":" << (static_cast<int32_t>(shm->thrust_cmd_y) / 65536.0) << ","
               << "\"thrust_z\":" << shm->thrust_cmd_z << ","
               << "\"torque\":" << (static_cast<int32_t>(shm->torque_cmd) / 65536.0) << ","
               << "\"wheel_rpm\":" << state.wheel_rpm << ","
               << "\"wheel_rpm_x\":" << state.wheel_rpm_x << ","
               << "\"wheel_rpm_y\":" << state.wheel_rpm_y << ","
               << "\"wheel_rpm_z\":" << state.wheel_rpm_z << ","
               << "\"wheel_torque\":" << (static_cast<int32_t>(shm->wheel_torque_cmd) / 65536.0) << ","
               << "\"score\":" << referee.total_score << ","
               << "\"checkpoint_score\":" << referee.checkpoint_score << ","
               << "\"bonus_score\":" << referee.bonus_score << ","
               << "\"passed_checkpoints\":" << referee.passed_checkpoints << ","
               << "\"total_checkpoints\":" << referee.total_checkpoints << ","
               << "\"mission_status\":\"" << (referee.is_failed ? "FAILED" : (referee.is_completed ? "COMPLETE" : "ACTIVE")) << "\","
               << "\"official_grade\":\"" << referee.official_grade << "\","
               << "\"last_event\":\"" << referee.last_event << "\","
               << "\"elapsed_time\":" << referee.elapsed_time << ","
               << "\"thruster_health\":" << physics.get_thruster_health() << ","
               << "\"detumble_time\":" << physics.get_detumble_time() << ","
               << "\"is_detumbled\":" << (physics.is_detumbled() ? 1 : 0) << ","
               << "\"debris_hits\":" << physics.get_debris_hits() << ","
               << "\"chaos_seed\":" << physics.get_chaos_seed() << ","
               << "\"debris_azimuth\":" << physics.get_impact_scenario().approach_azimuth << ","
               << "\"debris_elevation\":" << physics.get_impact_scenario().approach_elevation << ","
               << "\"debris_spawn_x\":" << physics.get_impact_scenario().spawn_point.x << ","
               << "\"debris_spawn_y\":" << physics.get_impact_scenario().spawn_point.y << ","
               << "\"debris_spawn_z\":" << physics.get_impact_scenario().spawn_point.z << ","
               << "\"debris_impact_x\":" << physics.get_impact_scenario().impact_point.x << ","
               << "\"debris_impact_y\":" << physics.get_impact_scenario().impact_point.y << ","
               << "\"debris_impact_z\":" << physics.get_impact_scenario().impact_point.z << ","
               << "\"damaged_thruster_1\":" << physics.get_impact_scenario().primary_damaged_id << ","
               << "\"damaged_thruster_2\":" << physics.get_impact_scenario().secondary_damaged_id
               << "}\n";
            jf.close();
            rename("/tmp/space_guidance_telemetry.json.tmp", "/tmp/space_guidance_telemetry.json");
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    std::cout << "[SpaceGuidance Daemon] Simulation ended." << std::endl;
    munmap(shm, 4096);
    close(fd);
    return 0;
}
