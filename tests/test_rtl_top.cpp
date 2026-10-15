#include <iostream>
#include <cassert>
#include <verilated.h>
#include "Vspace_guidance_top.h"

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

    // Reset sequence
    top->s_axi_aresetn = 0;
    for (int i = 0; i < 5; ++i) tick(top);
    top->s_axi_aresetn = 1;
    tick(top);

    std::cout << "[TEST] 1. Initial Register Read & Write" << std::endl;
    axi_write(top, 0x00, 0x01); // Enable system
    uint32_t cr = axi_read(top, 0x00);
    assert(cr == 0x01 && "Control register write failed!");
    std::cout << "  ✓ CR_CTRL = 0x" << std::hex << cr << " (System Enabled)" << std::dec << std::endl;

    std::cout << "[TEST] 2. Line Sensor Centroid Calculation" << std::endl;
    // Inject line pattern on channel 3 and 4 (center)
    top->raw_sensor_adc_i = (10 << 12) | (10 << 16);
    tick(top);
    tick(top);
    uint32_t edge = axi_read(top, 0x0C);
    int32_t signed_edge = static_cast<int32_t>(edge);
    std::cout << "  ✓ Centroid Q16.16: " << signed_edge << " (near center 0)" << std::endl;
    assert(std::abs(signed_edge) < 2000 && "Line centroid offset too large for centered input!");

    std::cout << "[TEST] 3. SEU Parity Robustness during Dynamic Thrust Writes (X and Y)" << std::endl;
    // Write alternating commands to X and Y
    axi_write(top, 0x24, 0x01); // Kick watchdog
    axi_write(top, 0x10, 0x00000001); // X write
    tick(top);
    uint32_t st = axi_read(top, 0x04);
    assert((st & 0x04) == 0 && "SEU false alarm triggered on X write!");
    axi_write(top, 0x14, 0x00000002); // Y write
    tick(top);
    st = axi_read(top, 0x04);
    assert((st & 0x04) == 0 && "SEU false alarm triggered on Y write!");
    std::cout << "  ✓ Dynamic thrust command changes (X and Y) verified without false SEU trip!" << std::endl;

    std::cout << "[TEST] 4. PWM Full-Scale Saturation & Continuous 100% Verification" << std::endl;
    // Set safety limit to 2.0 (0x00020000)
    axi_write(top, 0x20, 0x00020000);
    
    // Command +1.0 forward thrust (0x00010000)
    axi_write(top, 0x10, 0x00010000);
    // Check all 256 counter cycles: bit 0 MUST stay 1'b1 continuously with 0% dropout
    for (int i = 0; i < 256; ++i) {
        tick(top);
        assert((top->thruster_pwm_o & 0x01) == 0x01 && "PWM dropped out during full 100% command!");
        assert((top->thruster_pwm_o & 0x02) == 0x00 && "Reverse thruster firing erroneously!");
    }
    std::cout << "  ✓ +1.0 Full-Scale Thrust: PWM Bit 0 = strictly 100.00% active across all 256 cycles" << std::endl;

    // Command -1.0 reverse thrust (0xFFFF0000)
    axi_write(top, 0x10, 0xFFFF0000);
    for (int i = 0; i < 256; ++i) {
        tick(top);
        assert((top->thruster_pwm_o & 0x02) == 0x02 && "Reverse thruster PWM not asserted on -1.0 command!");
        assert((top->thruster_pwm_o & 0x01) == 0x00 && "Forward thruster firing erroneously!");
    }
    std::cout << "  ✓ -1.0 Reverse Thrust: PWM Bit 1 = strictly 100.00% active across all 256 cycles" << std::endl;

    std::cout << "[TEST] 5. Signed Safety Limit Clamping (Assertions on Clamped Outputs)" << std::endl;
    // Set safety limit to 0.5 (0x00008000)
    axi_write(top, 0x20, 0x00008000);
    // Command -1.0 reverse thrust -> must be clamped to -0.5 (0xFFFF8000)
    axi_write(top, 0x10, 0xFFFF0000);
    tick(top);
    assert(top->safe_thrust_cmd_x_o == 0xFFFF8000 && "Negative thrust not clamped to -0.5!");

    // Command +1.0 forward thrust -> must be clamped to +0.5 (0x00008000)
    axi_write(top, 0x10, 0x00010000);
    tick(top);
    assert(top->safe_thrust_cmd_x_o == 0x00008000 && "Positive thrust not clamped to +0.5!");

    // Command within-limit +0.25 (0x00004000) -> must pass through unchanged
    axi_write(top, 0x10, 0x00004000);
    tick(top);
    assert(top->safe_thrust_cmd_x_o == 0x00004000 && "Within-limit thrust altered!");

    // Command -1.0 Y-axis lateral thrust -> must be clamped to -0.5
    axi_write(top, 0x14, 0xFFFF0000);
    tick(top);
    assert(top->safe_thrust_cmd_y_o == 0xFFFF8000 && "Y-axis negative thrust not clamped to -0.5!");
    std::cout << "  ✓ Bidirectional clamping for X and Y axes verified with exact bit-level assertions!" << std::endl;

    std::cout << "[TEST] 6. Safety Watchdog Timeout Check" << std::endl;
    // Don't kick watchdog for 60,000 cycles -> should trip E-STOP
    for (int i = 0; i < 60000; ++i) {
        tick(top);
    }
    uint32_t status = axi_read(top, 0x04);
    std::cout << "  ✓ Status after timeout: 0x" << std::hex << status << std::dec << std::endl;
    assert((status & 0x08) != 0 && "Watchdog timeout bit not set!");
    assert((status & 0x02) != 0 && "E-STOP interlock bit not tripped!");
    assert(top->estop_interlock_o == 1 && "estop_interlock_o not asserted!");
    assert(top->thruster_pwm_o == 0 && "PWM not cut off after E-STOP!");

    std::cout << "[TEST] 7. Chaos SEU Fault Injection Check" << std::endl;
    axi_write(top, 0x24, 0x01); // Kick watchdog
    axi_write(top, 0x28, 0x01); // Inject SEU
    tick(top);
    status = axi_read(top, 0x04);
    assert((status & 0x04) != 0 && "SEU bit not set in status!");
    std::cout << "  ✓ SEU Fault Injection Alert Triggered!" << std::endl;

    delete top;
    std::cout << "==========================================================" << std::endl;
    std::cout << "✨ ALL 7 RTL TESTS (100% PWM / MULTI-AXIS CLAMP / SEU) PASSED" << std::endl;
    std::cout << "==========================================================" << std::endl;
    return 0;
}
