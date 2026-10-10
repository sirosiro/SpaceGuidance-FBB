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
    Vec2 pos;          // Position (meters)
    Vec2 vel;          // Velocity (m/s)
    double angle = 0.0;// Yaw angle (radians)
    double omega = 0.0;// Angular velocity (rad/s)
    double fuel = 100.0;// Fuel percentage / Delta-V budget (m/s)
    bool is_docked = false;
};

struct PipelinePoint {
    double x;
    double y;
};

class SpacePhysicsEngine {
public:
    SpacePhysicsEngine(double mass = 100.0, double inertia = 25.0);

    // Initialize Stage 1 Asteroid Pipeline track
    void init_stage1_asteroid_track();

    // Step physics with applied thruster forces (Newtons) and torque (N*m)
    void step(double thrust_forward, double thrust_lateral, double torque, double dt = 0.01);

    // Compute 8-channel optical line sensor ADC values (packed into 32-bit uint)
    uint32_t compute_sensor_adc() const;

    // Get current state
    const SpacecraftState& get_state() const { return state_; }
    void set_state(const SpacecraftState& s) { state_ = s; }

    // Distance to nearest point on pipeline
    double get_cross_track_error() const;

private:
    double mass_;
    double inertia_;
    SpacecraftState state_;
    std::vector<PipelinePoint> track_;

    double get_distance_to_track(double px, double py) const;
};
