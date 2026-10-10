#include <iostream>
#include <cassert>
#include <verilated.h>
#include "Vspace_guidance_top.h"

vluint64_t main_time = 0;
double sc_time_stamp() { return main_time; }

void tick(Vspace_guidance_top* top) {
    top->s_axi_aclk = 0;
    top->eval();
    main_time += 5;
    top->s_axi_aclk = 1;
    top->eval();
    main_time += 5;
}

void axi_write(Vspace_guidance_top* top, uint32_t addr, uint32_t data) {
    top->s_axi_awaddr = addr;
    top->s_axi_awvalid = 1;
    top->s_axi_wdata = data;
    top->s_axi_wvalid = 1;
    top->s_axi_bready = 1;
    while (!top->s_axi_awready || !top->s_axi_wready) {
        tick(top);
    }
    tick(top);
    top->s_axi_awvalid = 0;
    top->s_axi_wvalid = 0;
    while (!top->s_axi_bvalid) {
        tick(top);
    }
    tick(top);
    top->s_axi_bready = 0;
}

uint32_t axi_read(Vspace_guidance_top* top, uint32_t addr) {
    top->s_axi_araddr = addr;
    top->s_axi_arvalid = 1;
    top->s_axi_rready = 1;
    while (!top->s_axi_arready) {
        tick(top);
    }
    tick(top);
    top->s_axi_arvalid = 0;
    while (!top->s_axi_rvalid) {
        tick(top);
    }
    uint32_t val = top->s_axi_rdata;
    tick(top);
    top->s_axi_rready = 0;
    return val;
}

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    auto* top = new Vspace_guidance_top;

    // Reset
    top->s_axi_aresetn = 0;
    top->raw_sensor_adc_i = 0;
    for (int i = 0; i < 5; ++i) tick(top);
    top->s_axi_aresetn = 1;
    tick(top);

    std::cout << "[TEST] 1. Initial Register Read & Write" << std::endl;
    axi_write(top, 0x00, 0x00000001); // Enable system
    uint32_t cr = axi_read(top, 0x00);
    assert(cr == 1 && "CR_CTRL write/read mismatch!");
    std::cout << "  ✓ CR_CTRL = 0x" << std::hex << cr << " (System Enabled)" << std::dec << std::endl;

    std::cout << "[TEST] 2. Line Sensor Centroid Calculation" << std::endl;
    // Inject line pattern on channel 3 and 4 (center)
    // ch3 = 10, ch4 = 10 -> (10*3 + 10*4)/20 = 70/20 = 3.5 (perfect center)
    top->raw_sensor_adc_i = (10 << 12) | (10 << 16);
    tick(top);
    tick(top);
    uint32_t edge = axi_read(top, 0x0C);
    int32_t signed_edge = static_cast<int32_t>(edge);
    std::cout << "  ✓ Centroid Q16.16: " << signed_edge << " (near center 0)" << std::endl;
    assert(std::abs(signed_edge) < 2000 && "Line centroid offset too large for centered input!");

    std::cout << "[TEST] 3. Safety Watchdog Timeout Check" << std::endl;
    // Don't kick watchdog for 60,000 cycles -> should trip E-STOP
    for (int i = 0; i < 60000; ++i) {
        tick(top);
    }
    uint32_t status = axi_read(top, 0x04);
    std::cout << "  ✓ Status after timeout: 0x" << std::hex << status << std::dec << std::endl;
    assert((status & 0x08) != 0 && "Watchdog timeout bit not set!");
    assert((status & 0x02) != 0 && "E-STOP interlock bit not tripped!");
    assert(top->estop_interlock_o == 1 && "estop_interlock_o not asserted!");

    std::cout << "[TEST] 4. Chaos SEU Fault Injection Check" << std::endl;
    axi_write(top, 0x24, 0x01); // Kick watchdog
    axi_write(top, 0x28, 0x01); // Inject SEU
    tick(top);
    status = axi_read(top, 0x04);
    assert((status & 0x04) != 0 && "SEU Alert bit not set on Chaos injection!");
    std::cout << "  ✓ SEU Fault Injection Alert Triggered!" << std::endl;

    delete top;
    std::cout << "==========================================" << std::endl;
    std::cout << "✨ ALL RTL UNIT TESTS PASSED (100% SUCCESS)" << std::endl;
    std::cout << "==========================================" << std::endl;
    return 0;
}
