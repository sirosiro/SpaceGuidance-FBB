#include "space_physics.hpp"
#include <algorithm>

SpacePhysicsEngine::SpacePhysicsEngine(double mass, double inertia)
    : mass_(mass), inertia_(inertia) {
    init_stage1_asteroid_track();
}

void SpacePhysicsEngine::init_stage1_asteroid_track() {
    track_.clear();
    // Stage 1 Track: 50m pipeline along asteroid surface with smooth S-curves
    // Start at (0, 0), straight for 10m, curve right, curve left, straight to (50, 0)
    for (double x = 0.0; x <= 50.0; x += 0.2) {
        double y = 0.0;
        if (x > 10.0 && x <= 25.0) {
            // S-curve part 1
            y = 2.5 * std::sin((x - 10.0) / 15.0 * M_PI);
        } else if (x > 25.0 && x <= 40.0) {
            // S-curve part 2
            y = -2.5 * std::sin((x - 25.0) / 15.0 * M_PI);
        }
        track_.push_back({x, y});
    }
}

void SpacePhysicsEngine::step(double thrust_forward, double thrust_lateral, double rcs_torque, double wheel_torque, double dt) {
    // Zero-friction, microgravity rigid-body dynamics (F = m*a, tau = I*alpha)
    // Convert body-frame thruster forces to inertial frame
    double cos_a = std::cos(state_.angle);
    double sin_a = std::sin(state_.angle);

    double fx = thrust_forward * cos_a - thrust_lateral * sin_a;
    double fy = thrust_forward * sin_a + thrust_lateral * cos_a;

    // Linear motion (semi-implicit Euler / Verlet)
    double ax = fx / mass_;
    double ay = fy / mass_;

    state_.vel.x += ax * dt;
    state_.vel.y += ay * dt;

    state_.pos.x += state_.vel.x * dt;
    state_.pos.y += state_.vel.y * dt;

    // Reaction Wheel Dynamics
    // Flywheel inertia Iw = 0.02 kg*m^2, Max Speed = 6000 RPM (~628.3 rad/s)
    const double wheel_inertia = 0.02;
    const double max_wheel_rad_s = 6000.0 * (2.0 * M_PI / 60.0);
    double current_wheel_rad_s = state_.wheel_rpm * (2.0 * M_PI / 60.0);

    // Saturation protection
    double actual_wheel_torque = wheel_torque;
    if (current_wheel_rad_s >= max_wheel_rad_s && wheel_torque > 0.0) {
        actual_wheel_torque = 0.0;
    } else if (current_wheel_rad_s <= -max_wheel_rad_s && wheel_torque < 0.0) {
        actual_wheel_torque = 0.0;
    }

    // Accelerate internal flywheel
    double wheel_alpha = actual_wheel_torque / wheel_inertia;
    current_wheel_rad_s += wheel_alpha * dt;
    current_wheel_rad_s = std::clamp(current_wheel_rad_s, -max_wheel_rad_s, max_wheel_rad_s);
    state_.wheel_rpm = current_wheel_rad_s * (60.0 / (2.0 * M_PI));

    // Spacecraft Rotational motion (Newton's 3rd Law counter-torque)
    // Net body torque = RCS thruster torque - Reaction Wheel motor torque
    double net_torque = rcs_torque - actual_wheel_torque;
    double alpha = net_torque / inertia_;
    state_.omega += alpha * dt;
    state_.angle += state_.omega * dt;

    // Fuel consumption: ONLY thrusters consume propellant! Reaction wheel consumes zero fuel!
    double thrust_mag = std::abs(thrust_forward) + std::abs(thrust_lateral) + std::abs(rcs_torque);
    state_.fuel = std::max(0.0, state_.fuel - (thrust_mag * 0.0005 * dt));
}

double SpacePhysicsEngine::get_distance_to_track(double px, double py) const {
    double min_d2 = 1e9;
    for (const auto& pt : track_) {
        double dx = px - pt.x;
        double dy = py - pt.y;
        double d2 = dx * dx + dy * dy;
        if (d2 < min_d2) min_d2 = d2;
    }
    return std::sqrt(min_d2);
}

double SpacePhysicsEngine::get_cross_track_error() const {
    return get_distance_to_track(state_.pos.x, state_.pos.y);
}

uint32_t SpacePhysicsEngine::compute_sensor_adc() const {
    // Optical sensor bar is 0.5m in front of the vehicle center
    // 8 channels spread laterally across width 0.4m (-0.2m to +0.2m)
    double sensor_ahead = 0.5;
    double cos_a = std::cos(state_.angle);
    double sin_a = std::sin(state_.angle);

    double bar_center_x = state_.pos.x + sensor_ahead * cos_a;
    double bar_center_y = state_.pos.y + sensor_ahead * sin_a;

    // Lateral direction perpendicular to heading
    double lat_x = -sin_a;
    double lat_y = cos_a;

    uint32_t packed_adc = 0;
    for (int i = 0; i < 8; ++i) {
        double offset = -0.175 + (i * 0.05); // 8 channels from -0.175m to +0.175m
        double ch_x = bar_center_x + offset * lat_x;
        double ch_y = bar_center_y + offset * lat_y;

        double dist = get_distance_to_track(ch_x, ch_y);

        // Gaussian intensity curve for retro-reflective pipeline line (sigma ~ 0.06m)
        double intensity = 15.0 * std::exp(-(dist * dist) / (2.0 * 0.06 * 0.06));
        int adc_val = std::clamp(static_cast<int>(std::round(intensity)), 0, 15);

        packed_adc |= (static_cast<uint32_t>(adc_val) << (i * 4));
    }
    return packed_adc;
}
