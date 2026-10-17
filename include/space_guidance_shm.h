#pragma once
#include <cstdint>
#include <cstddef>

#define SPACE_GUIDANCE_SHM_MAGIC 0x53504731 // 'SPG1'
#define SPACE_GUIDANCE_SHM_PATH  "/dev/shm/fbb_space_guidance_shm"
#define SPACE_GUIDANCE_LEGACY_SHM "/tmp/vfpga_reg"

#pragma pack(push, 4)

struct SpaceGuidanceTelemetryExt {
    // 0xB0: 3D Kinematics & Physical Dynamics (8-byte aligned)
    double pos_z;
    double vel_z;
    double roll;
    double pitch;
    double yaw;
    double omega_x;
    double omega_y;
    double omega_z;
    double wheel_rpm_x;
    double wheel_rpm_y;
    double wheel_rpm_z;
    double cable_tension;
    double cable_vibration;
    double detumble_time;
    double elapsed_time;

    // 0x128: Debris Collision & Impact Geometry
    double debris_azimuth;
    double debris_elevation;
    double debris_spawn_x;
    double debris_spawn_y;
    double debris_spawn_z;
    double debris_impact_x;
    double debris_impact_y;
    double debris_impact_z;

    // 0x168: Scores, Status Codes & Damage Flags
    int32_t checkpoint_score;
    int32_t bonus_score;
    uint32_t cable_snapped;
    uint32_t thruster_health;
    uint32_t is_detumbled;
    uint32_t debris_hits;
    uint32_t chaos_seed;
    uint32_t damaged_thruster_1;
    uint32_t damaged_thruster_2;
    uint32_t mission_status_code; // 0: ACTIVE, 1: COMPLETE, 2: FAILED

    // 0x190: Human-Readable Telemetry Strings
    char official_grade[32];      // Null-terminated string (e.g. "IN_FLIGHT", "GRADE A")
    char last_event[64];          // Null-terminated event string
};

// Full Shared Memory Structure for SpaceGuidance (4096-byte MMIO page compatible)
struct ShmSpaceGuidance {
    // 0x00 - 0x2F: Standard Hardware Registers (UIO MMIO)
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
    uint32_t wheel_torque_cmd; // 0x2C

    // 0x30 - 0x7F: Base 2D Telemetry & Scoring Export
    double pos_x;              // 0x30
    double pos_y;              // 0x38
    double vel_x;              // 0x40
    double vel_y;              // 0x48
    double angle;              // 0x50
    double omega;              // 0x58
    double fuel;               // 0x60
    double cross_track_err;    // 0x68
    double wheel_rpm;          // 0x70
    uint32_t fdir_mode;        // 0x78
    uint32_t stage_id;         // 0x7C

    // 0x80 - 0x8F: Official Referee & Scoring Engine
    int32_t official_score;    // 0x80
    uint32_t passed_gates;     // 0x84
    uint32_t mission_status;   // 0x88 (0: Active, 1: Complete, 2: Failed)
    uint32_t total_gates;      // 0x8C

    // 0x90 - 0xA7: Extended Multi-Axis Control Commands (written by controller/autopilot)
    int32_t torque_x_cmd;      // 0x90
    int32_t torque_y_cmd;      // 0x94
    int32_t wheel_torque_x_cmd;// 0x98
    int32_t wheel_torque_y_cmd;// 0x9C
    int32_t thrust_vertical_cmd;//0xA0
    uint32_t reserved_a4;      // 0xA4

    // 0xA8 - 0xAF: Synchronization Header & Seqlock
    uint32_t magic;            // 0xA8: SPACE_GUIDANCE_SHM_MAGIC
    uint32_t seq_num;          // 0xAC: Seqlock sequence counter (odd: writing, even: valid)

    // 0xB0 - 0x1EF: Extended 6-DoF Telemetry & Referee Details
    SpaceGuidanceTelemetryExt ext;
};

#pragma pack(pop)

static_assert(offsetof(ShmSpaceGuidance, pos_x) == 0x30, "pos_x offset mismatch");
static_assert(offsetof(ShmSpaceGuidance, torque_x_cmd) == 0x90, "torque_x_cmd offset mismatch");
static_assert(offsetof(ShmSpaceGuidance, magic) == 0xA8, "magic offset mismatch");
static_assert(offsetof(ShmSpaceGuidance, seq_num) == 0xAC, "seq_num offset mismatch");
static_assert(offsetof(ShmSpaceGuidance, ext) == 0xB0, "ext offset mismatch");
static_assert(sizeof(ShmSpaceGuidance) == 496, "sizeof ShmSpaceGuidance mismatch");
