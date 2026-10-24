#pragma once
#include <vector>
#include <cmath>
#include <cstdint>
#include <string>

struct Vec2 {
    double x = 0.0;
    double y = 0.0;
};

struct Vec3 {
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;
};

struct SpacecraftState {
    Vec2 pos;          // Position (meters): Stage 1 (X, Y), Stage 2 (Height X, Vibration Y), Stage 3 (Rail X, Y), Stage 4 (Range X, Lateral Y)
    Vec2 vel;          // Velocity (m/s)
    double angle = 0.0;// Yaw angle (radians)
    double omega = 0.0;// Angular velocity (rad/s)
    double fuel = 100.0;// Fuel percentage / Delta-V budget (%)
    bool is_docked = false;
    double wheel_rpm = 0.0; // Reaction Wheel spin speed (RPM)
    double cable_tension = 10000.0; // Stage 2: Cable tension (N)
    double cable_vibration = 0.0;   // Stage 2: Cable transverse vibration displacement (m)
    bool is_cable_snapped = false;  // Stage 2: Cable rupture flag
    double rail_load = 0.0;         // Stage 3: Centrifugal / contact rail force (N)
    double laser_offset = 0.0;      // Stage 4: QPD beam offset (m)

    // Stage 5: Full-Spec 6-DoF Panic Control
    double pos_z = 0.0;
    double vel_z = 0.0;
    double roll = 0.0;          // Roll Euler angle (phi)
    double pitch = 0.0;         // Pitch Euler angle (theta)
    double yaw = 0.0;           // Yaw Euler angle (psi, synonymous with angle)
    double omega_x = 0.0;       // Roll rate P (rad/s)
    double omega_y = 0.0;       // Pitch rate Q (rad/s)
    double omega_z = 0.0;       // Yaw rate R (rad/s, synonymous with omega)
    double wheel_rpm_x = 0.0;   // 3-axis Reaction Wheel X (RPM)
    double wheel_rpm_y = 0.0;   // 3-axis Reaction Wheel Y (RPM)
    double wheel_rpm_z = 0.0;   // 3-axis Reaction Wheel Z (RPM)
    uint32_t thruster_health_mask = 0x0FFF; // 12-channel mask (bits 1 and 6 damaged: 0b111110111101)
    double detumble_time = 0.0;     // Time taken to achieve detumble (s)
    bool is_detumbled = false;      // True when |omega| < 0.05 rad/s achieved
    int debris_hits = 0;            // Count of secondary debris collisions
    bool is_escaped = false;        // Reached safe orbit boundary (X >= 35m)
};

struct PipelinePoint {
    double x;
    double y;
};

struct DebrisImpactScenario {
    uint32_t seed = 0x1337;
    double approach_azimuth = -2.45;     // rad (angle around Z axis)
    double approach_elevation = 0.28;    // rad (angle above/below XY plane)
    Vec3 impact_point{-1.1, 1.2, 0.15};  // body coordinates (m)
    Vec3 spawn_point{-16.0, -12.0, 3.5}; // relative spawn coordinates (m)
    Vec3 linear_drift{0.35, -0.20, 0.12};// velocity jump (m/s)
    Vec3 angular_rate{0.8, 0.6, 2.4};    // initial tumble (rad/s)
    uint32_t damage_mask = 0x0FBD;       // which thrusters damaged
    int primary_damaged_id = 1;
    int secondary_damaged_id = 6;
};

struct TrussDefect {
    int joint_id = 1;        // 1..4 (1: 15m, 2: 30m, 3: 45m, 4: 60m)
    double joint_x = 15.0;   // meters
    double angle_deg = 0.0;  // 0.0 ~ 360.0 degrees around joint ring
    double angle_rad = 0.0;
    bool detected = false;
    double dwell_timer = 0.0;
};

class SpacePhysicsEngine {
public:
    SpacePhysicsEngine(double mass = 100.0, double inertia = 25.0, int stage_id = 1);

    // Initialize track / world for specific stage
    void init_stage(int stage_id);
    void init_stage1_asteroid_track();
    void init_stage2_tether();
    void init_stage3_iss_truss();
    void init_stage4_laser_docking();
    void init_stage5_panic_control();

    // Step physics with applied thruster forces (Newtons) and torque (N*m), supports full 6-DoF
    void step(double thrust_forward, double thrust_lateral, double rcs_torque, double wheel_torque = 0.0,
              double dt = 0.01, uint32_t direct_thruster_mask = 0,
              double torque_x = 0.0, double torque_y = 0.0,
              double wheel_torque_x = 0.0, double wheel_torque_y = 0.0,
              double thrust_vertical = 0.0,
              double mission_elapsed_time = -1.0);

    // Compute sensor ADC values (packed into 32-bit uint)
    uint32_t compute_sensor_adc() const;

    // Get current state
    const SpacecraftState& get_state() const { return state_; }
    void set_state(const SpacecraftState& s) { state_ = s; }

    // Distance to nearest point on pipeline / tether error / rail load / laser offset
    double get_cross_track_error() const;

    int get_stage() const { return stage_id_; }
    double get_cable_tension() const { return state_.cable_tension; }
    double get_cable_vibration() const { return state_.cable_vibration; }
    double get_rail_load() const { return state_.rail_load; }
    void set_fdir_mode(uint32_t mode) { fdir_mode_ = mode; }

    // Stage 5 Getters & Setters
    uint32_t get_thruster_health() const { return state_.thruster_health_mask; }
    void set_thruster_health(uint32_t mask) { state_.thruster_health_mask = mask; }
    int get_debris_hits() const { return state_.debris_hits; }
    double get_detumble_time() const { return state_.detumble_time; }
    bool is_detumbled() const { return state_.is_detumbled; }
    bool is_escaped() const { return state_.is_escaped; }
    const std::vector<Vec3>& get_floating_debris() const { return floating_debris_; }
    const DebrisImpactScenario& get_impact_scenario() const { return impact_scenario_; }
    void set_chaos_seed(uint32_t seed);
    uint32_t get_chaos_seed() const { return impact_scenario_.seed; }
    // Stage 3 ISS Truss 360-deg Defect Inspection
    const std::vector<TrussDefect>& get_truss_defects() const { return truss_defects_; }
    int get_defects_detected_count() const { return defects_detected_count_; }
    double get_sensor_snr() const { return sensor_snr_; }
    double get_scan_angle_deg() const { return scan_angle_deg_; }
    double get_beam_width_deg() const { return beam_width_deg_; }
    void set_scan_turret(double angle_deg, double beam_width_deg) {
        scan_angle_deg_ = angle_deg;
        beam_width_deg_ = beam_width_deg;
    }

private:
    int stage_id_ = 1;
    double mass_;
    double inertia_;
    SpacecraftState state_;
    std::vector<PipelinePoint> track_;

    // Stage 2 Tether Climber specific dynamics
    double cable_vib_vel_ = 0.0;
    double prev_thrust_x_ = 0.0;
    const double cable_omega_0_ = 2.0 * M_PI * 5.0; // 5.0 Hz fundamental resonance mode
    const double cable_damping_ = 0.03;            // Light damping in vacuum space
    const double cable_max_tension_ = 15000.0;     // 15,000 N rupture threshold

    // Stage 3 ISS Truss dynamics & 360-deg flaw search
    double rail_load_ = 0.0;
    uint32_t fdir_mode_ = 0;
    std::vector<TrussDefect> truss_defects_;
    double scan_angle_deg_ = 0.0;
    double beam_width_deg_ = 15.0;
    double sensor_snr_ = 0.0;
    int defects_detected_count_ = 0;

    // Stage 4 Laser Docking target
    double target_angle_ = 0.0;

    // Stage 5 Panic Control dynamics & debris field
    std::vector<Vec3> floating_debris_;
    double detumble_hold_timer_ = 0.0;
    double stage5_elapsed_time_ = 0.0;
    bool has_impacted_ = false;
    DebrisImpactScenario impact_scenario_;

    void calculate_impact_scenario(uint32_t seed);
    void calculate_truss_defects(uint32_t seed);
    double get_distance_to_track(double px, double py) const;
};
