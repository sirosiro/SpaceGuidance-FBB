#include "space_physics.hpp"
#include <algorithm>
#include <iostream>

SpacePhysicsEngine::SpacePhysicsEngine(double mass, double inertia, int stage_id)
    : stage_id_(stage_id), mass_(mass), inertia_(inertia) {
    init_stage(stage_id_);
}

void SpacePhysicsEngine::init_stage(int stage_id) {
    stage_id_ = stage_id;
    if (stage_id_ == 2) {
        init_stage2_tether();
    } else if (stage_id_ == 3) {
        init_stage3_iss_truss();
    } else if (stage_id_ == 4) {
        init_stage4_laser_docking();
    } else {
        init_stage1_asteroid_track();
    }
}

void SpacePhysicsEngine::init_stage1_asteroid_track() {
    track_.clear();
    // Stage 1 Track: 50m pipeline along asteroid surface with smooth S-curves
    for (double x = 0.0; x <= 50.0; x += 0.01) {
        double y = 0.0;
        if (x > 10.0 && x <= 25.0) {
            y = 2.5 * std::sin((x - 10.0) / 15.0 * M_PI);
        } else if (x > 25.0 && x <= 40.0) {
            y = -2.5 * std::sin((x - 25.0) / 15.0 * M_PI);
        }
        track_.push_back({x, y});
    }
    state_.pos = {0.0, 0.0};
    state_.vel = {0.0, 0.0};
    state_.angle = 0.0;
    state_.omega = 0.0;
    state_.fuel = 100.0;
    state_.wheel_rpm = 0.0;
    state_.is_docked = false;
}

void SpacePhysicsEngine::init_stage2_tether() {
    track_.clear();
    // Stage 2 Track: 100m straight vertical carbon tether from (0, 0) to (100, 0)
    for (double x = 0.0; x <= 100.0; x += 0.5) {
        track_.push_back({x, 0.0});
    }
    state_.pos = {0.0, 0.0};
    state_.vel = {0.0, 0.0};
    state_.angle = 0.0;
    state_.omega = 0.0;
    state_.cable_tension = 10000.0;
    state_.cable_vibration = 0.0;
    state_.is_cable_snapped = false;
    state_.fuel = 100.0;
    state_.is_docked = false;
    cable_vib_vel_ = 0.0;
    prev_thrust_x_ = 0.0;
}

void SpacePhysicsEngine::init_stage3_iss_truss() {
    track_.clear();
    // Stage 3: 60m 3D Truss Rail Corridor
    for (double x = 0.0; x <= 60.0; x += 0.5) {
        track_.push_back({x, 0.0});
    }
    state_.pos = {0.0, 0.0};
    state_.vel = {0.0, 0.0};
    state_.angle = 0.0;
    state_.omega = 0.0;
    state_.fuel = 100.0;
    state_.rail_load = 0.0;
    state_.is_docked = false;
    rail_load_ = 0.0;
}

void SpacePhysicsEngine::init_stage4_laser_docking() {
    track_.clear();
    // Stage 4: 50m Optical Laser Docking Corridor
    for (double x = 0.0; x <= 50.0; x += 0.5) {
        track_.push_back({x, 0.0});
    }
    state_.pos = {0.0, 0.8}; // Initial 0.8m lateral offset
    state_.vel = {0.0, 0.0};
    state_.angle = 0.01;
    state_.omega = 0.0;
    state_.fuel = 100.0;
    state_.laser_offset = 0.8;
    state_.is_docked = false;
    target_angle_ = 0.0;
}

void SpacePhysicsEngine::step(double thrust_forward, double thrust_lateral, double rcs_torque, double wheel_torque, double dt) {
    if (stage_id_ == 2) {
        // -------------------------------------------------------------
        // Stage 2: 1D Tether Climber Dynamics with Coupled String Resonance
        // -------------------------------------------------------------
        if (state_.is_cable_snapped) {
            state_.vel.x -= 0.1 * dt;
            state_.pos.x += state_.vel.x * dt;
            if (state_.pos.x < 0.0) { state_.pos.x = 0.0; state_.vel.x = 0.0; }
            return;
        }

        double drive_force = thrust_forward;
        double friction_and_gravity = 5.0;
        double net_force = drive_force - friction_and_gravity;
        if (state_.pos.x <= 0.0 && net_force < 0.0) net_force = 0.0;

        double ax = net_force / mass_;
        state_.vel.x += ax * dt;
        if (state_.vel.x < 0.0 && state_.pos.x <= 0.0) state_.vel.x = 0.0;
        state_.pos.x += state_.vel.x * dt;
        if (state_.pos.x < 0.0) state_.pos.x = 0.0;

        double jerk = (thrust_forward - prev_thrust_x_) / dt;
        prev_thrust_x_ = thrust_forward;

        // Transverse cable vibration excited by motor jerk
        double jerk_excitation = 0.00015 * jerk;
        double vib_acc = -2.0 * cable_damping_ * cable_omega_0_ * cable_vib_vel_ 
                         - (cable_omega_0_ * cable_omega_0_) * state_.cable_vibration 
                         + jerk_excitation;
        
        cable_vib_vel_ += vib_acc * dt;
        state_.cable_vibration += cable_vib_vel_ * dt;
        state_.pos.y = state_.cable_vibration;

        // Cable tension: Nominal + Inertial acceleration + Vibration stress
        state_.cable_tension = 10000.0 + (mass_ * std::max(0.0, ax)) + (1200.0 * std::abs(state_.cable_vibration));
        if (state_.cable_tension > cable_max_tension_) {
            state_.is_cable_snapped = true;
            std::cerr << "\033[1;31m[TETHER RUPTURE] Cable tension exceeded limit (" 
                      << state_.cable_tension << " N > " << cable_max_tension_ << " N)!\033[0m\n";
        }

        state_.fuel -= (std::abs(drive_force) * 0.0003) * dt;
        if (state_.fuel < 0.0) state_.fuel = 0.0;
        return;
    }

    if (stage_id_ == 3) {
        // -------------------------------------------------------------
        // Stage 3: ISS Truss Crawler Dynamics along Structural Rails
        // -------------------------------------------------------------
        double drive_force = thrust_forward;
        double rolling_resistance = 2.0 * ((state_.vel.x > 0.0) ? 1.0 : ((state_.vel.x < 0.0) ? -1.0 : 0.0));
        double net_force = drive_force - rolling_resistance;
        if (state_.pos.x <= 0.0 && net_force < 0.0) net_force = 0.0;

        double ax = net_force / mass_;
        state_.vel.x += ax * dt;
        if (state_.vel.x < 0.0 && state_.pos.x <= 0.0) state_.vel.x = 0.0;
        state_.pos.x += state_.vel.x * dt;
        if (state_.pos.x < 0.0) state_.pos.x = 0.0;

        // Centrifugal rail load calculation in curved sections (20-25m and 40-45m)
        double px = state_.pos.x;
        double curvature = 0.0;
        if ((px >= 20.0 && px <= 25.0) || (px >= 40.0 && px <= 45.0)) {
            curvature = 0.20; // 1/R where R = 5.0m
        }
        double v2 = state_.vel.x * state_.vel.x;
        double cent_force = mass_ * v2 * curvature; // F = m * v^2 / R
        state_.rail_load = cent_force + std::abs(thrust_lateral);
        rail_load_ = state_.rail_load;

        state_.fuel -= (std::abs(drive_force) * 0.0004 + 0.005) * dt;
        if (state_.fuel < 0.0) state_.fuel = 0.0;
        return;
    }

    if (stage_id_ == 4) {
        // -------------------------------------------------------------
        // Stage 4: 6-DoF Microgravity Laser Docking Corridor
        // -------------------------------------------------------------
        double cos_a = std::cos(state_.angle);
        double sin_a = std::sin(state_.angle);

        double fx = thrust_forward * cos_a - thrust_lateral * sin_a;
        double fy = thrust_forward * sin_a + thrust_lateral * cos_a;

        double ax = fx / mass_;
        double ay = fy / mass_;

        state_.vel.x += ax * dt;
        state_.vel.y += ay * dt;

        state_.pos.x += state_.vel.x * dt;
        state_.pos.y += state_.vel.y * dt;
        if (state_.pos.x < 0.0) { state_.pos.x = 0.0; state_.vel.x = 0.0; }

        double alpha = rcs_torque / inertia_;
        state_.omega += alpha * dt;
        state_.angle += state_.omega * dt;

        while (state_.angle > M_PI) state_.angle -= 2.0 * M_PI;
        while (state_.angle < -M_PI) state_.angle += 2.0 * M_PI;

        state_.laser_offset = state_.pos.y;

        double fuel_burn = (std::abs(thrust_forward) + std::abs(thrust_lateral) + std::abs(rcs_torque)) * 0.0006;
        state_.fuel -= fuel_burn * dt;
        if (state_.fuel < 0.0) state_.fuel = 0.0;

        if (state_.pos.x >= 49.95 && std::abs(state_.pos.y) <= 0.05 && state_.vel.x <= 0.05) {
            state_.is_docked = true;
        }
        return;
    }

    // -------------------------------------------------------------
    // Stage 1: 2D Zero-Friction Rigid-Body Microgravity Motion
    // -------------------------------------------------------------
    double cos_a = std::cos(state_.angle);
    double sin_a = std::sin(state_.angle);

    double fx = thrust_forward * cos_a - thrust_lateral * sin_a;
    double fy = thrust_forward * sin_a + thrust_lateral * cos_a;

    double ax = fx / mass_;
    double ay = fy / mass_;

    state_.vel.x += ax * dt;
    state_.vel.y += ay * dt;

    state_.pos.x += state_.vel.x * dt;
    state_.pos.y += state_.vel.y * dt;

    // Reaction Wheel Dynamics
    const double wheel_inertia = 0.02;
    const double max_wheel_rad_s = 6000.0 * (2.0 * M_PI / 60.0);
    double current_wheel_rad_s = state_.wheel_rpm * (2.0 * M_PI / 60.0);

    double actual_wheel_torque = wheel_torque;
    if (current_wheel_rad_s >= max_wheel_rad_s && wheel_torque > 0.0) {
        actual_wheel_torque = 0.0;
    } else if (current_wheel_rad_s <= -max_wheel_rad_s && wheel_torque < 0.0) {
        actual_wheel_torque = 0.0;
    }

    double delta_wheel_rad_s = (actual_wheel_torque / wheel_inertia) * dt;
    current_wheel_rad_s += delta_wheel_rad_s;
    current_wheel_rad_s = std::clamp(current_wheel_rad_s, -max_wheel_rad_s, max_wheel_rad_s);
    state_.wheel_rpm = current_wheel_rad_s * (60.0 / (2.0 * M_PI));

    double tau_net = rcs_torque - actual_wheel_torque;
    double alpha = tau_net / inertia_;
    state_.omega += alpha * dt;
    state_.angle += state_.omega * dt;

    while (state_.angle > M_PI) state_.angle -= 2.0 * M_PI;
    while (state_.angle < -M_PI) state_.angle += 2.0 * M_PI;

    double fuel_burn_rate = (std::abs(thrust_forward) + std::abs(thrust_lateral) + std::abs(rcs_torque)) * 0.0005;
    state_.fuel -= fuel_burn_rate * dt;
    if (state_.fuel < 0.0) state_.fuel = 0.0;
}

uint32_t SpacePhysicsEngine::compute_sensor_adc() const {
    if (stage_id_ == 2) {
        // Stage 2: Optical mark sensor along tether (pitch mark every 1.0m, mark width 0.06m)
        double dist_to_mark = std::abs(state_.pos.x - std::round(state_.pos.x));
        uint32_t adc = 0;
        if (dist_to_mark < 0.06) {
            adc = 0xFFFFFFFF;
        } else {
            uint32_t level = std::clamp(static_cast<int>(15.0 - std::abs(state_.cable_vibration) * 120.0), 0, 15);
            for (int i = 0; i < 8; ++i) adc |= (level << (i * 4));
        }
        return adc;
    }

    if (stage_id_ == 3) {
        // Stage 3: Proximity sensor to inspection joints (15m, 30m, 45m, 60m)
        const double joints[] = {15.0, 30.0, 45.0, 60.0};
        uint32_t adc = 0;
        for (int i = 0; i < 4; ++i) {
            double d = std::abs(state_.pos.x - joints[i]);
            if (d < 1.0) {
                uint32_t intensity = std::clamp(static_cast<int>((1.0 - d) * 15.0), 0, 15);
                adc |= (intensity << (i * 8));
            }
        }
        return adc;
    }

    if (stage_id_ == 4) {
        // Stage 4: 4-Quadrant Photodiode (QPD) receiver
        // Beam center is at Y=0.0. Spot width ~ 0.05m
        double dy = state_.pos.y;
        double q_top = std::clamp(static_cast<int>(std::exp(- (dy - 0.02) * (dy - 0.02) / 0.005) * 15.0), 0, 15);
        double q_bot = std::clamp(static_cast<int>(std::exp(- (dy + 0.02) * (dy + 0.02) / 0.005) * 15.0), 0, 15);
        uint32_t adc = (static_cast<uint32_t>(q_top) << 24) | (static_cast<uint32_t>(q_top) << 16) | (static_cast<uint32_t>(q_bot) << 8) | static_cast<uint32_t>(q_bot);
        return adc;
    }

    // Stage 1: 8-channel optical line sensor array on asteroid surface
    double sensor_x = state_.pos.x + 0.5 * std::cos(state_.angle);
    double sensor_y = state_.pos.y + 0.5 * std::sin(state_.angle);
    double perp_x = -std::sin(state_.angle);
    double perp_y =  std::cos(state_.angle);

    uint32_t adc_packed = 0;
    for (int i = 0; i < 8; ++i) {
        double offset = (i - 3.5) * 0.05;
        double ch_x = sensor_x + offset * perp_x;
        double ch_y = sensor_y + offset * perp_y;
        double dist = get_distance_to_track(ch_x, ch_y);

        double intensity = std::exp(- (dist * dist) / (2.0 * 0.04 * 0.04));
        uint32_t adc_val = std::clamp(static_cast<int>(intensity * 15.0), 0, 15);
        adc_packed |= (adc_val << (i * 4));
    }
    return adc_packed;
}

double SpacePhysicsEngine::get_distance_to_track(double px, double py) const {
    if (track_.empty()) return 0.0;
    double min_dist_sq = 1e9;
    for (const auto& pt : track_) {
        double dx = px - pt.x;
        double dy = py - pt.y;
        double d2 = dx*dx + dy*dy;
        if (d2 < min_dist_sq) min_dist_sq = d2;
    }
    return std::sqrt(min_dist_sq);
}

double SpacePhysicsEngine::get_cross_track_error() const {
    if (stage_id_ == 2) {
        return state_.cable_vibration;
    }
    if (stage_id_ == 3) {
        return state_.rail_load;
    }
    if (stage_id_ == 4) {
        return state_.pos.y;
    }
    double d = get_distance_to_track(state_.pos.x, state_.pos.y);
    double nominal_y = 0.0;
    double x = state_.pos.x;
    if (x > 10.0 && x <= 25.0) {
        nominal_y = 2.5 * std::sin((x - 10.0) / 15.0 * M_PI);
    } else if (x > 25.0 && x <= 40.0) {
        nominal_y = -2.5 * std::sin((x - 25.0) / 15.0 * M_PI);
    }
    return (state_.pos.y >= nominal_y) ? d : -d;
}
