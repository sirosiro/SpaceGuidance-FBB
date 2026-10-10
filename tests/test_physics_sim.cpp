#include <iostream>
#include <cassert>
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
        physics.step(50.0, 0.0, 0.0, 0.01);
    }
    double v1 = physics.get_state().vel.x;
    std::cout << "  Velocity after 1s burn: " << v1 << " m/s (Expected: ~0.5 m/s)" << std::endl;
    assert(std::abs(v1 - 0.5) < 0.01 && "Velocity calculation mismatch!");

    // Coast for 2.0 seconds with zero thrust -> velocity must remain strictly constant
    for (int i = 0; i < 200; ++i) {
        physics.step(0.0, 0.0, 0.0, 0.01);
    }
    double v2 = physics.get_state().vel.x;
    std::cout << "  Velocity after 2s coast: " << v2 << " m/s (Strictly frictionless)" << std::endl;
    assert(v1 == v2 && "Frictionless coasting failed - velocity changed without thrust!");

    std::cout << "[TEST PHASE 2] 2. Line Sensor to RTL Centroid Feedback Loop" << std::endl;
    // Set position right at origin on track
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

    // Move vehicle laterally to the right by +0.1m
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

    delete top;
    std::cout << "==========================================================" << std::endl;
    std::cout << "✨ PHASE 2: PHYSICS ENGINE & RTL CO-SIM VERIFIED (100% PASS)" << std::endl;
    std::cout << "==========================================================" << std::endl;
    return 0;
}
