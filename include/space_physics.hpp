#pragma once
#include <vector>
#include <cmath>
#include <cstdint>
#include <string>

struct Vec2 {
    double x = 0.0;
    double y = 0.0;
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
};

struct PipelinePoint {
    double x;
    double y;
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

    // Step physics with applied thruster forces (Newtons) and torque (N*m)
    void step(double thrust_forward, double thrust_lateral, double rcs_torque, double wheel_torque = 0.0, double dt = 0.01);

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
    bool is_cable_snapped() const { return state_.is_cable_snapped; }
    double get_rail_load() const { return state_.rail_load; }

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

    // Stage 3 ISS Truss dynamics
    double rail_load_ = 0.0;

    // Stage 4 Laser Docking target
    double target_angle_ = 0.0;

    double get_distance_to_track(double px, double py) const;
};
