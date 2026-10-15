#include <iostream>
#include <cassert>
#include <cmath>
#include <verilated.h>
#include "Vspace_guidance_top.h"
#include "space_physics.hpp"

void tick(Vspace_guidance_top* top) {
    top->s_axi_aclk = 0;
    top->eval();
    top->s_axi_aclk = 1;
    top->eval();
}

void axi_write(Vspace_guidance_top* top, uint32_t addr, uint32_t data) {
    top->s_axi_awaddr = addr;
    top->s_axi_awvalid = 1;
    top->s_axi_wdata = data;
    top->s_axi_wvalid = 1;
    top->s_axi_bready = 1;
    while (!top->s_axi_awready || !top->s_axi_wready) tick(top);
    tick(top);
    top->s_axi_awvalid = 0;
    top->s_axi_wvalid = 0;
    while (!top->s_axi_bvalid) tick(top);
    tick(top);
    top->s_axi_bready = 0;
}

uint32_t axi_read(Vspace_guidance_top* top, uint32_t addr) {
    top->s_axi_araddr = addr;
    top->s_axi_arvalid = 1;
    top->s_axi_rready = 1;
    while (!top->s_axi_arready) tick(top);
    tick(top);
    top->s_axi_arvalid = 0;
    while (!top->s_axi_rvalid) tick(top);
    uint32_t val = top->s_axi_rdata;
    tick(top);
    top->s_axi_rready = 0;
    return val;
}

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    auto* top = new Vspace_guidance_top;
    SpacePhysicsEngine physics(100.0, 25.0);

    // Reset RTL
    top->s_axi_aresetn = 0;
    for (int i = 0; i < 5; ++i) tick(top);
    top->s_axi_aresetn = 1;
    tick(top);

    // Enable system & set safety limits
    axi_write(top, 0x00, 0x01); // Enable
    axi_write(top, 0x20, 0x00010000); // 1.0 limit

    std::cout << "[TEST PHASE 2] 1. Zero-Friction Inertia Coasting Verification" << std::endl;
    // Fire forward thruster 50N for 1.0 second (100 steps of dt=0.01s)
    for (int i = 0; i < 100; ++i) {
        physics.step(50.0, 0.0, 0.0, 0.0, 0.01);
    }
    double v1 = physics.get_state().vel.x;
    std::cout << "  Velocity after 1s burn: " << v1 << " m/s (Expected: ~0.5 m/s)" << std::endl;
    assert(std::abs(v1 - 0.5) < 0.01 && "Velocity calculation mismatch!");

    // Coast for 2.0 seconds with zero thrust -> velocity must remain strictly constant
    for (int i = 0; i < 200; ++i) {
        physics.step(0.0, 0.0, 0.0, 0.0, 0.01);
    }
    double v2 = physics.get_state().vel.x;
    std::cout << "  Velocity after 2s coast: " << v2 << " m/s (Strictly frictionless)" << std::endl;
    assert(v1 == v2 && "Frictionless coasting failed - velocity changed without thrust!");

    std::cout << "[TEST PHASE 2] 2. Line Sensor to RTL Centroid Feedback Loop" << std::endl;
    SpacecraftState s;
    s.pos = {0.0, 0.0};
    s.angle = 0.0;
    physics.set_state(s);

    uint32_t adc = physics.compute_sensor_adc();
    top->raw_sensor_adc_i = adc;
    tick(top);
    tick(top);

    uint32_t edge = axi_read(top, 0x0C);
    int32_t signed_edge = static_cast<int32_t>(edge);
    std::cout << "  On-track centered ADC: 0x" << std::hex << adc << std::dec << ", Centroid: " << signed_edge << std::endl;
    assert(std::abs(signed_edge) < 2000 && "Centroid not near center when vehicle is centered on track!");

    // Move vehicle laterally to the right by +0.10m
    s.pos = {0.0, 0.10};
    physics.set_state(s);
    adc = physics.compute_sensor_adc();
    top->raw_sensor_adc_i = adc;
    tick(top);
    tick(top);

    edge = axi_read(top, 0x0C);
    signed_edge = static_cast<int32_t>(edge);
    std::cout << "  Offset +0.10m ADC: 0x" << std::hex << adc << std::dec << ", Centroid: " << signed_edge << std::endl;
    assert(signed_edge != 0 && "Centroid failed to shift when vehicle moved off-center!");

    std::cout << "[TEST PHASE 2] 3. Dynamic Closed-Loop Co-Simulation (ADC -> RTL -> PD -> AXI -> PWM -> Physics)" << std::endl;
    // Start vehicle at x=0.0, y=0.10 (off-center to the right by 10cm) with zero initial velocity
    s.pos = {0.0, 0.10};
    s.vel = {0.0, 0.0};
    s.angle = 0.0;
    s.omega = 0.0;
    physics.set_state(s);

    // Initial forward thrust
    axi_write(top, 0x24, 0x01); // Kick watchdog
    axi_write(top, 0x10, 0x00008000); // Forward +0.5 (25N)

    double kp = 0.6;
    double kd = 0.1;
    double prev_err = 0.0;
    double dt = 0.01;
    double initial_cmd = 0.0;
    double final_cmd = 0.0;

    // Run 70 co-simulation cycles (each cycle: 256 RTL clock ticks = 1 physics step of 0.01s = 0.7s total)
    for (int step = 0; step < 70; ++step) {
        // Step A: Physics computes sensor ADC based on current spacecraft position
        uint32_t sensor_adc = physics.compute_sensor_adc();
        top->raw_sensor_adc_i = sensor_adc;

        // Step B: Clock RTL so line_sensor_filter computes centroid
        tick(top);
        tick(top);

        // Step C: Read RTL centroid calculation via AXI register 0x0C
        uint32_t raw_edge = axi_read(top, 0x0C);
        int32_t signed_edge = static_cast<int32_t>(raw_edge);
        double err = static_cast<double>(signed_edge) / 65536.0;

        // Step D: Dynamically compute corrective lateral thrust via PD control
        double d_err = (err - prev_err) / dt;
        prev_err = err;
        double corrective_thrust = kp * err + kd * d_err;
        if (corrective_thrust > 1.0) corrective_thrust = 1.0;
        if (corrective_thrust < -1.0) corrective_thrust = -1.0;
        int32_t q16_cmd = static_cast<int32_t>(corrective_thrust * 65536.0);

        if (step == 1) initial_cmd = corrective_thrust;
        if (step == 69) final_cmd = corrective_thrust;

        // Step E: Dynamically write feedback command via AXI
        axi_write(top, 0x14, static_cast<uint32_t>(q16_cmd));
        if (step % 5 == 0) axi_write(top, 0x24, 0x01); // Kick watchdog

        // Step F: Step RTL clocks to evaluate PWM
        double fx = 0.0;
        double fy = 0.0;
        for (int c = 0; c < 256; ++c) {
            tick(top);
            if (top->thruster_pwm_o & 0x01) fx += (50.0 / 256.0);
            if (top->thruster_pwm_o & 0x02) fx -= (50.0 / 256.0);
            if (top->thruster_pwm_o & 0x04) fy += (50.0 / 256.0);
            if (top->thruster_pwm_o & 0x08) fy -= (50.0 / 256.0);
        }

        // Step G: Actuate physics engine using actual PWM thrust forces produced by RTL
        physics.step(fx, fy, 0.0, 0.0, dt);
    }

    SpacecraftState final_state = physics.get_state();
    std::cout << "  Closed-loop position after 0.7s: X=" << final_state.pos.x << "m, Y=" << final_state.pos.y << "m" << std::endl;
    std::cout << "  Lateral command response: Initial=" << initial_cmd << ", Final=" << final_cmd << std::endl;

    // Assertions for True Dynamic Closed-Loop Causation:
    assert(final_state.pos.x > 0.05 && "Spacecraft failed to advance under RTL PWM thrust!");
    assert(std::abs(final_state.pos.y) < 0.03 && "Spacecraft failed to converge toward track center (|y| < 0.03m)!");
    assert(std::abs(initial_cmd) > 0.2 && "Initial corrective command was inactive!");
    assert(std::abs(final_cmd) < std::abs(initial_cmd) && "Command magnitude failed to throttle down upon convergence!");
    std::cout << "  ✓ Closed-loop dynamic feedback causation (Sensor->RTL->PD->PWM->Physics) verified!" << std::endl;

    delete top;
    std::cout << "==========================================================" << std::endl;
    std::cout << "✨ PHASE 2: PHYSICS ENGINE & RTL CO-SIM VERIFIED (100% PASS)" << std::endl;
    std::cout << "==========================================================" << std::endl;
    return 0;
}
