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
    } else if (stage_id_ == 5) {
        init_stage5_panic_control();
    } else {
        init_stage1_asteroid_track();
    }
}

void SpacePhysicsEngine::init_stage5_panic_control() {
    track_.clear();
    // Safe escape corridor: from X=0 to X=35m along Y=0
    for (double x = 0.0; x <= 35.0; x += 0.5) {
        track_.push_back({x, 0.0});
    }

    // Scatter secondary floating debris (10 obstacles scattered in 3D)
    floating_debris_.clear();
    floating_debris_.push_back({ 6.5,  2.2,  1.5});
    floating_debris_.push_back({10.0, -1.8, -1.2});
    floating_debris_.push_back({14.0,  1.5, -1.6});
    floating_debris_.push_back({17.5, -2.5,  1.8});
    floating_debris_.push_back({21.0,  1.2,  1.4});
    floating_debris_.push_back({24.5, -1.4, -1.5});
    floating_debris_.push_back({27.0,  2.8, -2.0});
    floating_debris_.push_back({29.5, -2.2,  1.6});
    floating_debris_.push_back({31.5,  1.6, -1.2});
    floating_debris_.push_back({33.5, -1.5,  1.4});

    // Initial state before collision (T < 0.6s):
    // Nominal stable 6-DoF flight approaching debris field
    state_.pos = {0.0, 0.0};
    state_.pos_z = 0.0;
    state_.vel = {0.0, 0.0};
    state_.vel_z = 0.0;
    state_.roll = 0.0;
    state_.pitch = 0.0;
    state_.yaw = 0.0;
    state_.angle = 0.0;
    state_.omega_x = 0.0;
    state_.omega_y = 0.0;
    state_.omega_z = 0.0;
    state_.omega = 0.0;         // Stable, zero spin before impact
    state_.wheel_rpm_x = 0.0;
    state_.wheel_rpm_y = 0.0;
    state_.wheel_rpm_z = 0.0;
    state_.fuel = 100.0;
    state_.wheel_rpm = 0.0;
    state_.is_docked = false;
    state_.thruster_health_mask = 0x0FFF; // All 12 thrusters intact before collision
    state_.detumble_time = 0.0;
    state_.is_detumbled = false;
    state_.debris_hits = 0;
    state_.is_escaped = false;

    detumble_hold_timer_ = 0.0;
    stage5_elapsed_time_ = 0.0;
    has_impacted_ = false;

    calculate_impact_scenario(0x1337);
}

void SpacePhysicsEngine::set_chaos_seed(uint32_t seed) {
    if (stage_id_ == 5 && !has_impacted_) {
        calculate_impact_scenario(seed);
    } else if (stage_id_ == 3) {
        calculate_truss_defects(seed);
    }
}

void SpacePhysicsEngine::calculate_impact_scenario(uint32_t seed) {
    impact_scenario_.seed = seed;
    if (seed == 0x1337) {
        // Calibrated baseline seed: Starboard-Aft strike (hitting near T1 & T6)
        impact_scenario_.approach_azimuth = -2.45;
        impact_scenario_.approach_elevation = 0.28;
        impact_scenario_.impact_point = {-1.1, 1.2, 0.15};
        impact_scenario_.angular_rate = {0.8, 0.6, 2.4};
        impact_scenario_.linear_drift = {0.35, -0.20, 0.12};
        impact_scenario_.damage_mask = 0x0FBD; // T1 and T6 destroyed
        impact_scenario_.primary_damaged_id = 1;
        impact_scenario_.secondary_damaged_id = 6;
    } else {
        // Deterministic PRNG from custom seed
        uint64_t state = (static_cast<uint64_t>(seed) * 6364136223846793005ULL) + 1442695040888963407ULL;
        auto next_double = [&state]() -> double {
            state = (state * 6364136223846793005ULL) + 1442695040888963407ULL;
            return static_cast<double>((state >> 32) & 0xFFFFFFFF) / 4294967296.0;
        };

        // 360-degree approach azimuth [-pi, pi] and elevation [-30 deg, +30 deg]
        double az = next_double() * 2.0 * M_PI - M_PI;
        double el = (next_double() - 0.5) * (M_PI / 3.0);
        impact_scenario_.approach_azimuth = az;
        impact_scenario_.approach_elevation = el;

        double cos_el = std::cos(el);
        double sin_el = std::sin(el);
        double cos_az = std::cos(az);
        double sin_az = std::sin(az);

        // Calculate impact point on body boundary
        double ix = std::clamp(cos_az * 1.3 + (next_double() - 0.5) * 0.3, -1.4, 1.4);
        double iy = std::clamp(sin_az * 1.3 + (next_double() - 0.5) * 0.3, -1.6, 1.6);
        double iz = std::clamp(sin_el * 0.5 + (next_double() - 0.5) * 0.2, -0.5, 0.5);
        impact_scenario_.impact_point = {ix, iy, iz};

        // Velocity vector of incoming debris (~32 m/s relative speed)
        double v_speed = 30.0 + next_double() * 5.0;
        double vx = -v_speed * cos_el * cos_az;
        double vy = -v_speed * cos_el * sin_az;
        double vz = -v_speed * sin_el;

        // Linear momentum transfer to 100kg spacecraft (m_deb ~ 1.1kg)
        double m_deb = 1.1;
        impact_scenario_.linear_drift.x = (m_deb / mass_) * vx;
        impact_scenario_.linear_drift.y = (m_deb / mass_) * vy;
        impact_scenario_.linear_drift.z = (m_deb / mass_) * vz;

        // Angular momentum impulse J = r_imp x P_debris
        double Px = m_deb * vx;
        double Py = m_deb * vy;
        double Pz = m_deb * vz;
        double Jx = iy * Pz - iz * Py;
        double Jy = iz * Px - ix * Pz;
        double Jz = ix * Py - iy * Px;

        double Ix = 15.0, Iy = 20.0, Iz = inertia_; // 25.0
        double wx = std::clamp(Jx / Ix * 1.5, -1.2, 1.2);
        double wy = std::clamp(Jy / Iy * 1.5, -1.0, 1.0);
        double wz = std::clamp(Jz / Iz * 1.5, -2.5, 2.5);
        if (std::abs(wz) < 1.5) wz = (wz >= 0 ? 2.2 : -2.2);

        impact_scenario_.angular_rate = {wx, wy, wz};

        // 12 Thruster positions in body frame
        const Vec3 thruster_pos[12] = {
            {-1.3, -1.0,  0.0}, // T0: Aft-Left
            {-1.3, +1.0,  0.0}, // T1: Aft-Right
            {+1.0, -0.6,  0.0}, // T2: Front-Left
            {+1.0, +0.6,  0.0}, // T3: Front-Right
            {-1.0, -1.8,  0.0}, // T4: Aft-Port
            {+0.8, -0.65, 0.0}, // T5: Front-Port
            {-1.0, +1.8,  0.0}, // T6: Aft-Stbd
            {+0.8, +0.65, 0.0}, // T7: Front-Stbd
            {+1.25, 0.0, +0.5}, // T8: Dorsal-Front
            {+1.25, 0.0, -0.5}, // T9: Ventral-Front
            {-1.25, 0.0, +0.5}, // T10: Dorsal-Aft
            {-1.25, 0.0, -0.5}  // T11: Ventral-Aft
        };

        std::vector<std::pair<double, int>> dists;
        for (int i = 0; i < 12; ++i) {
            double dx = thruster_pos[i].x - ix;
            double dy = thruster_pos[i].y - iy;
            double dz = thruster_pos[i].z - iz;
            double d = dx*dx + dy*dy + dz*dz;
            dists.push_back({d, i});
        }
        std::sort(dists.begin(), dists.end());

        int d1 = dists[0].second;
        int d2 = dists[1].second;
        impact_scenario_.primary_damaged_id = d1;
        impact_scenario_.secondary_damaged_id = d2;

        uint32_t mask = 0x0FFF;
        mask &= ~(1 << d1);
        mask &= ~(1 << d2);
        impact_scenario_.damage_mask = mask;
    }

    // Compute spawn point (incoming along approach ray from 18m away)
    double r_spawn = 18.0;
    double cos_el = std::cos(impact_scenario_.approach_elevation);
    double sin_el = std::sin(impact_scenario_.approach_elevation);
    double cos_az = std::cos(impact_scenario_.approach_azimuth);
    double sin_az = std::sin(impact_scenario_.approach_azimuth);
    impact_scenario_.spawn_point = {
        r_spawn * cos_el * cos_az,
        r_spawn * cos_el * sin_az,
        r_spawn * sin_el
    };
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
    // Stage 3: 60m 3D Truss Rail Corridor with geometric curves at 20-25m and 40-45m
    for (double x = 0.0; x <= 60.0; x += 0.2) {
        double y = 0.0;
        if (x >= 20.0 && x <= 25.0) {
            y = 1.0 * std::sin((x - 20.0) / 5.0 * M_PI);
        } else if (x >= 40.0 && x <= 45.0) {
            y = -1.0 * std::sin((x - 40.0) / 5.0 * M_PI);
        }
        track_.push_back({x, y});
    }
    state_.pos = {0.0, 0.0};
    state_.vel = {0.0, 0.0};
    state_.angle = 0.0;
    state_.yaw = 0.0;
    state_.omega = 0.0;
    state_.fuel = 100.0;
    state_.rail_load = 0.0;
    state_.is_docked = false;
    rail_load_ = 0.0;
    scan_angle_deg_ = 0.0;
    beam_width_deg_ = 15.0;
    sensor_snr_ = 0.0;
    defects_detected_count_ = 0;
    calculate_truss_defects(0x2026);
}

void SpacePhysicsEngine::calculate_truss_defects(uint32_t seed) {
    truss_defects_.clear();
    const double joint_coords[] = {15.0, 30.0, 45.0, 60.0};
    int clean_joint = seed % 4; // one joint out of four is clean

    uint32_t rng = seed ^ 0xA5A5A5A5;
    auto next_u32 = [&rng]() {
        rng = rng * 1664525u + 1013904223u;
        return rng;
    };

    for (int i = 0; i < 4; ++i) {
        if (i == clean_joint) continue;
        TrussDefect def;
        def.joint_id = i + 1;
        def.joint_x = joint_coords[i];
        uint32_t r_val = next_u32() % 3000;
        def.angle_deg = 30.0 + (r_val / 10.0); // 30.0 deg ~ 330.0 deg
        def.angle_rad = def.angle_deg * M_PI / 180.0;
        def.detected = false;
        def.dwell_timer = 0.0;
        truss_defects_.push_back(def);
    }
    defects_detected_count_ = 0;
    std::cout << "[Physics] Stage 3: 3 Hidden Structural Defects Generated:" << std::endl;
    for (const auto& d : truss_defects_) {
        std::cout << "  - Joint " << d.joint_id << " (" << d.joint_x << "m) at angle " << d.angle_deg << " deg" << std::endl;
    }
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

void SpacePhysicsEngine::step(double thrust_forward, double thrust_lateral, double rcs_torque, double wheel_torque,
                              double dt, uint32_t direct_thruster_mask,
                              double torque_x, double torque_y,
                              double wheel_torque_x, double wheel_torque_y,
                              double thrust_vertical,
                              double mission_elapsed_time) {
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
        double jerk_excitation = 0.0050 * jerk;
        double vib_acc = -2.0 * cable_damping_ * cable_omega_0_ * cable_vib_vel_ 
                         - (cable_omega_0_ * cable_omega_0_) * state_.cable_vibration 
                         + jerk_excitation;
        
        cable_vib_vel_ += vib_acc * dt;
        state_.cable_vibration += cable_vib_vel_ * dt;
        state_.pos.y = state_.cable_vibration;

        // Cable tension: Nominal + Inertial acceleration + Vibration stress
        state_.cable_tension = 10000.0 + (mass_ * std::max(0.0, ax)) + (50000.0 * std::abs(state_.cable_vibration));
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
        double drive_force = thrust_forward; // Positive: forward thrust, Negative: counter-thrust braking
        // In space vacuum, natural rolling friction is tiny (0.5N); stopping requires counter-thrusters!
        double rolling_resistance = 0.5 * ((state_.vel.x > 0.0) ? 1.0 : ((state_.vel.x < 0.0) ? -1.0 : 0.0));
        double net_force = drive_force - rolling_resistance;
        if (state_.pos.x <= 0.0 && net_force < 0.0) net_force = 0.0;

        // Electromagnetic gripper clamp dynamics (fdir_mode == 1) near joints
        const double joints[] = {15.0, 30.0, 45.0, 60.0};
        bool is_near_joint = false;
        int active_joint_id = -1;
        for (int i = 0; i < 4; ++i) {
            if (std::abs(state_.pos.x - joints[i]) <= 0.40) {
                is_near_joint = true;
                active_joint_id = i + 1;
                break;
            }
        }

        if (fdir_mode_ == 1 && is_near_joint) {
            // High-speed latching shock check: must decelerate to <= 0.40 m/s with counter-thrusters before clamping!
            if (std::abs(state_.vel.x) > 0.40) {
                state_.rail_load = 999.0; // clamp pin shear failure flag
            } else {
                // Firm mechanical lock onto joint docking collar
                state_.vel.x = 0.0;
                net_force = 0.0;
            }
        }

        // Straight-line over-speed limit check (> 3.50 m/s causes clamp chatter derailment)
        if (std::abs(state_.vel.x) > 3.50) {
            state_.rail_load = 888.0; // clamp chatter derailment flag
        }

        double ax = net_force / mass_;
        state_.vel.x += ax * dt;
        if (state_.vel.x < 0.0 && state_.pos.x <= 0.0) state_.vel.x = 0.0;
        state_.pos.x += state_.vel.x * dt;
        if (state_.pos.x < 0.0) state_.pos.x = 0.0;

        // Prevent reversing backward when already stationary
        if (state_.pos.x > 0.0 && state_.vel.x < 0.0 && drive_force < 0.0 && std::abs(state_.vel.x) < 0.05) {
            state_.vel.x = 0.0;
        }

        // Terminal physical endstop at 60.0m dock
        if (state_.pos.x >= 60.0) {
            state_.pos.x = 60.0;
            if (state_.vel.x > 0.0) state_.vel.x = 0.0;
        }

        // Centrifugal rail load calculation in curved sections (20-25m and 40-45m)
        double px = state_.pos.x;
        double curvature = 0.0;
        double py = 0.0;
        double heading = 0.0;
        if (px >= 20.0 && px <= 25.0) {
            curvature = 0.20; // 1/R where R = 5.0m
            double u = (px - 20.0) / 5.0;
            py = 1.0 * std::sin(u * M_PI);
            double dy_dx = 1.0 * (M_PI / 5.0) * std::cos(u * M_PI);
            heading = std::atan2(dy_dx, 1.0);
        } else if (px >= 40.0 && px <= 45.0) {
            curvature = 0.20; // 1/R where R = 5.0m
            double u = (px - 40.0) / 5.0;
            py = -1.0 * std::sin(u * M_PI);
            double dy_dx = -1.0 * (M_PI / 5.0) * std::cos(u * M_PI);
            heading = std::atan2(dy_dx, 1.0);
        }
        state_.pos.y = py;
        state_.angle = heading;
        state_.yaw = heading;

        double v2 = state_.vel.x * state_.vel.x;
        double cent_force = mass_ * v2 * curvature; // F = m * v^2 / R
        if (state_.rail_load < 800.0) {
            state_.rail_load = cent_force;
        }
        rail_load_ = state_.rail_load;

        // 360-deg Defect Inspection Sensor calculation
        if (fdir_mode_ == 1 && is_near_joint && active_joint_id != -1 && std::abs(state_.vel.x) < 0.1) {
            double max_snr = 0.0;
            for (auto& def : truss_defects_) {
                if (def.joint_id == active_joint_id) {
                    double diff = std::abs(scan_angle_deg_ - def.angle_deg);
                    while (diff > 180.0) diff = std::abs(diff - 360.0);
                    double half_w = std::max(2.5, beam_width_deg_ * 0.5);
                    if (diff <= half_w) {
                        double gain = 15.0 / std::max(5.0, beam_width_deg_);
                        double u = diff / half_w;
                        double profile = std::cos(u * (M_PI * 0.5));
                        double raw_s = 1000.0 * gain * (profile * profile);
                        if (raw_s > max_snr) max_snr = raw_s;
                        if (raw_s >= 600.0) {
                            def.dwell_timer += dt;
                            if (def.dwell_timer >= 0.15 && !def.detected) {
                                def.detected = true;
                                defects_detected_count_++;
                                std::cout << "\n>>> [SENSOR VERIFIED] Defect located at Joint " 
                                          << def.joint_id << " (" << def.joint_x << "m), angle "
                                          << def.angle_deg << " deg! (SNR=" << static_cast<int>(raw_s) << ") <<<\n" << std::endl;
                            }
                        } else {
                            def.dwell_timer = std::max(0.0, def.dwell_timer - dt * 0.5);
                        }
                    }
                }
            }
            sensor_snr_ = max_snr;
        } else {
            sensor_snr_ = 0.0;
        }

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

    if (stage_id_ == 5) {
        // -------------------------------------------------------------
        // Stage 5: Full 6-DoF Panic Control (Multi-Axis Collision & Recovery)
        // -------------------------------------------------------------
        if (mission_elapsed_time >= 0.0) {
            stage5_elapsed_time_ = mission_elapsed_time;
        } else {
            stage5_elapsed_time_ += dt;
        }

        // Before impact at T < 0.6s: strictly nominal straight cruise, zero tumbling!
        if (stage5_elapsed_time_ < 0.6) {
            has_impacted_ = false;
            state_.omega_x = 0.0;
            state_.omega_y = 0.0;
            state_.omega_z = 0.0;
            state_.omega   = 0.0;
            state_.roll    = 0.0;
            state_.pitch   = 0.0;
            state_.yaw     = 0.0;
            state_.angle   = 0.0;
            state_.vel.y   = 0.0;
            state_.vel_z   = 0.0;
            state_.thruster_health_mask = 0x0FFF; // All 12 thrusters intact prior to collision
            return;
        }

        // Collision Event at T = 0.6s (Debris hits spacecraft body with off-axis 3D impulse)
        if (!has_impacted_) {
            has_impacted_ = true;
            // 3D chaotic tumbling rates from seed-correlated impact dynamics
            state_.omega_x = impact_scenario_.angular_rate.x;
            state_.omega_y = impact_scenario_.angular_rate.y;
            state_.omega_z = impact_scenario_.angular_rate.z;
            state_.omega = state_.omega_z; // Legacy sync
            // 3D linear impulse momentum drift
            state_.vel.x = impact_scenario_.linear_drift.x;
            state_.vel.y = impact_scenario_.linear_drift.y;
            state_.vel_z = impact_scenario_.linear_drift.z;
            // 12-channel thruster damage mask calculated from impact proximity
            state_.thruster_health_mask = impact_scenario_.damage_mask;
        }

        // Check 3D detumble condition: total angular speed < 0.05 rad/s held >= 0.5s
        double omega_mag = std::sqrt(state_.omega_x * state_.omega_x +
                                     state_.omega_y * state_.omega_y +
                                     state_.omega_z * state_.omega_z);
        state_.omega = state_.omega_z; // Keep legacy sync
        if (omega_mag < 0.05) {
            detumble_hold_timer_ += dt;
            if (detumble_hold_timer_ >= 0.5 && !state_.is_detumbled) {
                state_.is_detumbled = true;
                state_.detumble_time = stage5_elapsed_time_;
            }
        } else {
            detumble_hold_timer_ = 0.0;
        }

        // Check escape condition: reached safe orbit boundary X >= 35.0m
        if (state_.pos.x >= 35.0) {
            state_.is_escaped = true;
        }

        // Check secondary floating debris proximity in 3D (radius < 1.5m)
        for (const auto& deb : floating_debris_) {
            double dx = state_.pos.x - deb.x;
            double dy = state_.pos.y - deb.y;
            double dz = state_.pos_z - deb.z;
            if (dx * dx + dy * dy + dz * dz < 1.5 * 1.5) {
                state_.debris_hits++;
            }
        }

        // 12 Thruster Geometry Table (Body coordinates: +X forward, +Y port, +Z dorsal)
        // T0..T7: Horizontal Plane (Z = 0)
        // T0: Aft-Left   (+X forward, CW  yaw:  Fx=+20, Fy=  0, Fz=  0, Tz=-20)
        // T1: Aft-Right  (+X forward, CCW yaw:  Fx=+20, Fy=  0, Fz=  0, Tz=+20) [DAMAGED]
        // T2: Front-Left (-X reverse, CCW yaw:  Fx=-20, Fy=  0, Fz=  0, Tz=+20)
        // T3: Front-Right(-X reverse, CW  yaw:  Fx=-20, Fy=  0, Fz=  0, Tz=-20)
        // T4: Aft-Port   (+Y port,    CW  yaw:  Fx=  0, Fy=+20, Fz=  0, Tz=-20)
        // T5: Front-Port (+Y port,    CCW yaw:  Fx=  0, Fy=+20, Fz=  0, Tz=+20)
        // T6: Aft-Stbd   (-Y stbd,    CCW yaw:  Fx=  0, Fy=-20, Fz=  0, Tz=+20) [DAMAGED]
        // T7: Front-Stbd (-Y stbd,    CW  yaw:  Fx=  0, Fy=-20, Fz=  0, Tz=-20)
        // T8..T11: Vertical / Pitch Plane (Z = +/-0.5m, X = +/-1.25m)
        // T8:  Forward Dorsal (Fz=+20, Ty=-25: Pitch Down)
        // T9:  Forward Ventral(Fz=-20, Ty=+25: Pitch Up)
        // T10: Aft Dorsal     (Fz=+20, Ty=+25: Pitch Up)
        // T11: Aft Ventral    (Fz=-20, Ty=-25: Pitch Down)
        const double F_NOZZLE = 20.0;
        const double th_fx[12] = {+20.0, +20.0, -20.0, -20.0,   0.0,   0.0,   0.0,   0.0,   0.0,   0.0,   0.0,   0.0};
        const double th_fy[12] = {  0.0,   0.0,   0.0,   0.0, +20.0, +20.0, -20.0, -20.0,   0.0,   0.0,   0.0,   0.0};
        const double th_fz[12] = {  0.0,   0.0,   0.0,   0.0,   0.0,   0.0,   0.0,   0.0, +20.0, -20.0, +20.0, -20.0};
        const double th_tx[12] = {  0.0,   0.0,   0.0,   0.0,   0.0,   0.0,   0.0,   0.0,   0.0,   0.0,   0.0,   0.0};
        const double th_ty[12] = {  0.0,   0.0,   0.0,   0.0,   0.0,   0.0,   0.0,   0.0, -25.0, +25.0, +25.0, -25.0};
        const double th_tz[12] = {-20.0, +20.0, +20.0, -20.0, -20.0, +20.0, +20.0, -20.0,   0.0,   0.0,   0.0,   0.0};

        double body_fx = 0.0, body_fy = 0.0, body_fz = 0.0;
        double body_tx = 0.0, body_ty = 0.0, body_tz = 0.0;
        double total_burn = 0.0;

        if (direct_thruster_mask != 0) {
            // Mode A: Direct actuation mask for System ID and Control Allocation (12 nozzles)
            for (int i = 0; i < 12; ++i) {
                if ((direct_thruster_mask & (1 << i)) != 0) {
                    bool is_healthy = (state_.thruster_health_mask & (1 << i)) != 0;
                    if (is_healthy) {
                        body_fx += th_fx[i];
                        body_fy += th_fy[i];
                        body_fz += th_fz[i];
                        body_tx += th_tx[i];
                        body_ty += th_ty[i];
                        body_tz += th_tz[i];
                        total_burn += F_NOZZLE;
                    } else {
                        total_burn += 0.5; // slight gas leak on dead nozzle attempt
                    }
                }
            }
        } else {
            // Mode B: Standard FSW mixer from (thrust_forward, thrust_lateral, thrust_vertical, rcs_torque, torque_x, torque_y)
            double duty[12] = {0.0};
            double ux  = std::clamp(thrust_forward / 40.0, -1.0, 1.0);
            double uy  = std::clamp(thrust_lateral / 40.0, -1.0, 1.0);
            double uz  = std::clamp(thrust_vertical / 40.0, -1.0, 1.0);
            double utz = std::clamp(rcs_torque / 40.0, -1.0, 1.0);
            double uty = std::clamp(torque_y / 50.0, -1.0, 1.0);

            // Forward / Reverse thrust (+X / -X)
            if (ux > 0) { duty[0] += ux; duty[1] += ux; }
            else if (ux < 0) { duty[2] += -ux; duty[3] += -ux; }

            // Lateral Port / Starboard thrust (+Y / -Y)
            if (uy > 0) { duty[4] += uy; duty[5] += uy; }
            else if (uy < 0) { duty[6] += -uy; duty[7] += -uy; }

            // Vertical Up / Down (+Z / -Z)
            if (uz > 0) { duty[8] += uz; duty[10] += uz; }
            else if (uz < 0) { duty[9] += -uz; duty[11] += -uz; }

            // Yaw torque (+Z / -Z)
            if (utz > 0) { duty[1] += utz; duty[2] += utz; duty[5] += utz; duty[6] += utz; }
            else if (utz < 0) { duty[0] += -utz; duty[3] += -utz; duty[4] += -utz; duty[7] += -utz; }

            // Pitch torque (+Y / -Y)
            if (uty > 0) { duty[9] += uty; duty[10] += uty; }
            else if (uty < 0) { duty[8] += -uty; duty[11] += -uty; }

            for (int i = 0; i < 12; ++i) {
                double d = std::clamp(duty[i], 0.0, 1.0);
                if (d > 0.0) {
                    bool is_healthy = (state_.thruster_health_mask & (1 << i)) != 0;
                    if (is_healthy) {
                        body_fx += d * th_fx[i];
                        body_fy += d * th_fy[i];
                        body_fz += d * th_fz[i];
                        body_tx += d * th_tx[i];
                        body_ty += d * th_ty[i];
                        body_tz += d * th_tz[i];
                        total_burn += d * F_NOZZLE;
                    }
                }
            }
        }

        // 3-Axis Reaction Wheel Cluster Dynamics (Flywheels applying reaction torque)
        const double wheel_inertia = 0.05;
        const double max_wheel_rad_s = 6000.0 * (2.0 * M_PI / 60.0);

        auto step_wheel = [&](double& rpm, double cmd_torque) -> double {
            double current_rad_s = rpm * (2.0 * M_PI / 60.0);
            double actual_torque = cmd_torque;
            if (current_rad_s >= max_wheel_rad_s && actual_torque < 0.0) {
                actual_torque = 0.0;
            } else if (current_rad_s <= -max_wheel_rad_s && actual_torque > 0.0) {
                actual_torque = 0.0;
            }
            double delta_rad_s = (-actual_torque / wheel_inertia) * dt;
            current_rad_s += delta_rad_s;
            current_rad_s = std::clamp(current_rad_s, -max_wheel_rad_s, max_wheel_rad_s);
            rpm = current_rad_s * (60.0 / (2.0 * M_PI));
            return actual_torque;
        };

        double rw_tx = step_wheel(state_.wheel_rpm_x, wheel_torque_x);
        double rw_ty = step_wheel(state_.wheel_rpm_y, wheel_torque_y);
        double rw_tz = step_wheel(state_.wheel_rpm_z, wheel_torque);
        state_.wheel_rpm = state_.wheel_rpm_z; // Sync primary yaw wheel

        // Principal Moments of Inertia
        const double Ix = 15.0; // Roll
        const double Iy = 20.0; // Pitch
        const double Iz = inertia_; // Yaw = 25.0

        double tau_net_x = body_tx + rw_tx;
        double tau_net_y = body_ty + rw_ty;
        double tau_net_z = body_tz + rw_tz;

        // Euler's 3D rotational dynamics with gyroscopic cross-coupling
        double alpha_x = (tau_net_x - (Iz - Iy) * state_.omega_y * state_.omega_z) / Ix;
        double alpha_y = (tau_net_y - (Ix - Iz) * state_.omega_z * state_.omega_x) / Iy;
        double alpha_z = (tau_net_z - (Iy - Ix) * state_.omega_x * state_.omega_y) / Iz;

        state_.omega_x += alpha_x * dt;
        state_.omega_y += alpha_y * dt;
        state_.omega_z += alpha_z * dt;
        state_.omega = state_.omega_z; // Legacy sync

        // 3D Euler Angle Kinematics (Tait-Bryan: Yaw psi, Pitch theta, Roll phi)
        double c_pitch = std::cos(state_.pitch);
        if (std::abs(c_pitch) < 0.01) c_pitch = (c_pitch >= 0.0) ? 0.01 : -0.01;
        double t_pitch = std::tan(state_.pitch);
        double s_roll = std::sin(state_.roll);
        double c_roll = std::cos(state_.roll);

        double d_roll  = state_.omega_x + s_roll * t_pitch * state_.omega_y + c_roll * t_pitch * state_.omega_z;
        double d_pitch = c_roll * state_.omega_y - s_roll * state_.omega_z;
        double d_yaw   = (s_roll * state_.omega_y + c_roll * state_.omega_z) / c_pitch;

        state_.roll  += d_roll * dt;
        state_.pitch += d_pitch * dt;
        state_.yaw   += d_yaw * dt;

        while (state_.roll > M_PI) state_.roll -= 2.0 * M_PI;
        while (state_.roll < -M_PI) state_.roll += 2.0 * M_PI;
        while (state_.pitch > M_PI) state_.pitch -= 2.0 * M_PI;
        while (state_.pitch < -M_PI) state_.pitch += 2.0 * M_PI;
        while (state_.yaw > M_PI) state_.yaw -= 2.0 * M_PI;
        while (state_.yaw < -M_PI) state_.yaw += 2.0 * M_PI;

        state_.angle = state_.yaw; // Legacy sync

        // Transform body forces to world inertial coordinates via DCM
        double cy = std::cos(state_.yaw),   sy = std::sin(state_.yaw);
        double cp = std::cos(state_.pitch), sp = std::sin(state_.pitch);
        double cr = std::cos(state_.roll),  sr = std::sin(state_.roll);

        double r00 = cy * cp;
        double r01 = cy * sp * sr - sy * cr;
        double r02 = cy * sp * cr + sy * sr;

        double r10 = sy * cp;
        double r11 = sy * sp * sr + cy * cr;
        double r12 = sy * sp * cr - cy * sr;

        double r20 = -sp;
        double r21 = cp * sr;
        double r22 = cp * cr;

        double world_fx = r00 * body_fx + r01 * body_fy + r02 * body_fz;
        double world_fy = r10 * body_fx + r11 * body_fy + r12 * body_fz;
        double world_fz = r20 * body_fx + r21 * body_fy + r22 * body_fz;

        state_.vel.x += (world_fx / mass_) * dt;
        state_.vel.y += (world_fy / mass_) * dt;
        state_.vel_z += (world_fz / mass_) * dt;

        state_.pos.x += state_.vel.x * dt;
        state_.pos.y += state_.vel.y * dt;
        state_.pos_z += state_.vel_z * dt;

        // Propellant consumption: burns + steady leak (0.15%/s)
        double fuel_burn = (total_burn * 0.0004 + 0.15) * dt;
        state_.fuel -= fuel_burn;
        if (state_.fuel < 0.0) state_.fuel = 0.0;
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
        // Stage 3: When clamped at joint, return real-time 360-deg flaw scan SNR (0 ~ 1023)
        if (fdir_mode_ == 1) {
            double noise = (rand() % 16);
            double snr_val = sensor_snr_ > 0.0 ? sensor_snr_ : noise;
            return static_cast<uint32_t>(std::clamp(snr_val, 0.0, 1023.0));
        }

        // When in transit, return proximity to next inspection joint
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

    if (stage_id_ == 5) {
        // Stage 5: Gyro angular rate & Thruster health telemetry packed into ADC
        uint32_t health = state_.thruster_health_mask & 0xFF;
        uint32_t gyro_mag = std::clamp(static_cast<int>(std::abs(state_.omega) * 50.0), 0, 255);
        uint32_t detumble_byte = state_.is_detumbled ? 0xFF : 0x00;
        return health | (gyro_mag << 8) | (detumble_byte << 24);
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
    if (stage_id_ == 5) {
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
