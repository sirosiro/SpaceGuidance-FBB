#include <cstring>
#include <iostream>
#include <fstream>
#include <chrono>
#include <thread>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
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
};

int main(int argc, char** argv) {
    int stage_id = 1;
    for (int i = 1; i < argc; ++i) {
        if (strncmp(argv[i], "--stage=", 8) == 0) {
            stage_id = atoi(argv[i] + 8);
        } else if (strcmp(argv[i], "--stage") == 0 && i + 1 < argc) {
            stage_id = atoi(argv[++i]);
        }
    }
    if (const char* stage_env = getenv("SPACE_GUIDANCE_STAGE")) {
        stage_id = atoi(stage_env);
    } else if (const char* fbb_stage = getenv("FBB_STAGE")) {
        stage_id = atoi(fbb_stage);
    }

    std::cout << "[SpaceGuidance Daemon] Initializing simulation daemon for Stage " << stage_id << "..." << std::endl;

    // Create / open shared memory file (F-BB standard: /tmp/vfpga_reg)
    const char* shm_env = getenv("FBB_SHM_PATH");
    const char* shm_path = shm_env ? shm_env : "/tmp/vfpga_reg";
    int fd = open(shm_path, O_RDWR | O_CREAT, 0666);
    if (fd < 0) {
        shm_path = "/tmp/fbb_space_guidance_shm";
        fd = open(shm_path, O_RDWR | O_CREAT, 0666);
    }
    if (fd < 0) {
        std::cerr << "Failed to open shared memory: " << shm_path << std::endl;
        return 1;
    }

    struct stat st;
    size_t target_size = 4096;
    if (fstat(fd, &st) == 0 && st.st_size < (off_t)target_size) {
        if (ftruncate(fd, target_size) != 0) {
            std::cerr << "Failed to truncate shared memory file" << std::endl;
            return 1;
        }
    }

    if (strcmp(shm_path, "/tmp/fbb_space_guidance_shm") != 0) {
        unlink("/tmp/fbb_space_guidance_shm");
        if (symlink(shm_path, "/tmp/fbb_space_guidance_shm") == 0) {}
    }

    auto* shm = static_cast<ShmSpaceGuidance*>(mmap(nullptr, sizeof(ShmSpaceGuidance),
                                                    PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0));
    if (shm == MAP_FAILED) {
        std::cerr << "Failed to mmap shared memory" << std::endl;
        return 1;
    }

    memset(shm, 0, sizeof(ShmSpaceGuidance));

    SpacePhysicsEngine physics(100.0, 25.0, stage_id);
    std::cout << "[SpaceGuidance Daemon] Ready. Running physics for Stage " << stage_id << " at 100Hz." << std::endl;

    shm->cr_ctrl = 1;
    shm->safety_limit = 0x00010000;
    shm->fuel = 100.0;
    shm->stage_id = stage_id;

    {
        std::ofstream jf("/tmp/space_guidance_telemetry.json");
        jf << "{\"stage_id\":" << stage_id 
           << ",\"pos_x\":0.0,\"pos_y\":0.0,\"vel_x\":0.0,\"vel_y\":0.0,\"angle\":0.0,\"omega\":0.0,\"fuel\":100.0,\"cross_track_err\":0.0,\"sensor_raw\":0,\"fdir_mode\":0}\n";
    }

    int tick_cnt = 0;
    while (shm->cr_ctrl & 0x01) {
        double fx = static_cast<int32_t>(shm->thrust_cmd_x) / 65536.0 * 50.0;
        double fy = static_cast<int32_t>(shm->thrust_cmd_y) / 65536.0 * 50.0;
        double tau_rcs = static_cast<int32_t>(shm->torque_cmd) / 65536.0 * 20.0;
        double tau_wheel = static_cast<int32_t>(shm->wheel_torque_cmd) / 65536.0 * 20.0;

        physics.step(fx, fy, tau_rcs, tau_wheel, 0.01);

        uint32_t adc = physics.compute_sensor_adc();
        shm->sensor_raw = adc;

        if (stage_id == 2) {
            // Stage 2: Encoder position / mark count
            uint32_t mark_cnt = static_cast<uint32_t>(physics.get_state().pos.x);
            shm->sensor_edge = mark_cnt;
        } else if (stage_id == 3) {
            // Stage 3: Encoder position / joint index
            uint32_t joint_mask = 0;
            double px = physics.get_state().pos.x;
            if (px >= 14.5 && px <= 15.5) joint_mask |= 1;
            if (px >= 29.5 && px <= 30.5) joint_mask |= 2;
            if (px >= 44.5 && px <= 45.5) joint_mask |= 4;
            if (px >= 59.5 && px <= 60.5) joint_mask |= 8;
            shm->sensor_edge = (joint_mask << 16) | static_cast<uint16_t>(px * 100.0);
        } else if (stage_id == 4) {
            // Stage 4: QPD lateral offset in Q16.16
            int32_t offset_q16 = static_cast<int32_t>(physics.get_state().pos.y * 65536.0);
            shm->sensor_edge = static_cast<uint32_t>(offset_q16);
        } else {
            // Stage 1: Line sensor centroid calculation (Q16.16)
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

        if (++tick_cnt % 2 == 0) {
            std::ofstream jf("/tmp/space_guidance_telemetry.json");
            jf << "{"
               << "\"stage_id\":" << stage_id << ","
               << "\"pos_x\":" << state.pos.x << ","
               << "\"pos_y\":" << state.pos.y << ","
               << "\"vel_x\":" << state.vel.x << ","
               << "\"vel_y\":" << state.vel.y << ","
               << "\"angle\":" << state.angle << ","
               << "\"omega\":" << state.omega << ","
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
               << "\"torque\":" << (static_cast<int32_t>(shm->torque_cmd) / 65536.0) << ","
               << "\"wheel_rpm\":" << state.wheel_rpm << ","
               << "\"wheel_torque\":" << (static_cast<int32_t>(shm->wheel_torque_cmd) / 65536.0)
               << "}\n";
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    munmap(shm, sizeof(ShmSpaceGuidance));
    close(fd);
    std::cout << "[SpaceGuidance Daemon] Clean shutdown." << std::endl;
    return 0;
}
