// space_guidance_top.v
// Top-level AXI4-Lite IP Core for SpaceGuidance System (RCS/Guidance/Interlock)
`timescale 1ns / 1ps

module space_guidance_top #(
    parameter integer C_S_AXI_DATA_WIDTH = 32,
    parameter integer C_S_AXI_ADDR_WIDTH = 6
)(
    // AXI4-Lite Clock & Reset
    input  wire                                  s_axi_aclk,
    input  wire                                  s_axi_aresetn,
    // AXI4-Lite Write Address
    input  wire [C_S_AXI_ADDR_WIDTH-1 : 0]       s_axi_awaddr,
    input  wire [2 : 0]                          s_axi_awprot,
    input  wire                                  s_axi_awvalid,
    output wire                                  s_axi_awready,
    // AXI4-Lite Write Data
    input  wire [C_S_AXI_DATA_WIDTH-1 : 0]       s_axi_wdata,
    input  wire [(C_S_AXI_DATA_WIDTH/8)-1 : 0]   s_axi_wstrb,
    input  wire                                  s_axi_wvalid,
    output wire                                  s_axi_wready,
    // AXI4-Lite Write Response
    output wire [1 : 0]                          s_axi_bresp,
    output wire                                  s_axi_bvalid,
    input  wire                                  s_axi_bready,
    // AXI4-Lite Read Address
    input  wire [C_S_AXI_ADDR_WIDTH-1 : 0]       s_axi_araddr,
    input  wire [2 : 0]                          s_axi_arprot,
    input  wire                                  s_axi_arvalid,
    output wire                                  s_axi_arready,
    // AXI4-Lite Read Data
    output wire [C_S_AXI_DATA_WIDTH-1 : 0]       s_axi_rdata,
    output wire [1 : 0]                          s_axi_rresp,
    output wire                                  s_axi_rvalid,
    input  wire                                  s_axi_rready,

    // Hardware Pins
    input  wire [31:0]                           raw_sensor_adc_i,
    output wire [7:0]                            thruster_pwm_o,
    output wire                                  estop_interlock_o,
    output wire                                  seu_alert_o,
    output wire                                  irq_o,
    // Direct test probe outputs for hardware verifier & ILA (All 3 primary axes)
    output wire [31:0]                           safe_thrust_cmd_x_o,
    output wire [31:0]                           safe_thrust_cmd_y_o,
    output wire [31:0]                           safe_torque_cmd_o
);

    // Register Offsets
    localparam ADDR_CR_CTRL         = 6'h00;
    localparam ADDR_SR_STATUS       = 6'h04;
    localparam ADDR_SENSOR_RAW      = 6'h08;
    localparam ADDR_SENSOR_EDGE     = 6'h0C;
    localparam ADDR_THRUST_CMD_X    = 6'h10;
    localparam ADDR_THRUST_CMD_Y    = 6'h14;
    localparam ADDR_THRUST_CMD_Z    = 6'h18;
    localparam ADDR_TORQUE_CMD      = 6'h1C;
    localparam ADDR_SAFETY_LIMIT    = 6'h20;
    localparam ADDR_WATCHDOG_KICK   = 6'h24;
    localparam ADDR_CHAOS_FAULT_INJ = 6'h28;
    localparam ADDR_WHEEL_TORQUE_CMD = 6'h2C;

    // Registers
    reg [31:0] reg_cr_ctrl;
    reg [31:0] reg_thrust_cmd_x;
    reg [31:0] reg_thrust_cmd_y;
    reg [31:0] reg_thrust_cmd_z;
    reg [31:0] reg_torque_cmd;
    reg [31:0] reg_safety_limit;
    reg [31:0] reg_chaos_fault_inj;
    reg [31:0] reg_wheel_torque_cmd;
    reg        wdg_kick_pulse;
    reg        command_write_pulse;

    // AXI handshakes
    reg awready_reg;
    reg wready_reg;
    reg bvalid_reg;
    reg arready_reg;
    reg rvalid_reg;
    reg [31:0] rdata_reg;

    assign s_axi_awready = awready_reg;
    assign s_axi_wready  = wready_reg;
    assign s_axi_bvalid  = bvalid_reg;
    assign s_axi_bresp   = 2'b00; // OKAY
    assign s_axi_arready = arready_reg;
    assign s_axi_rvalid  = rvalid_reg;
    assign s_axi_rresp   = 2'b00; // OKAY
    assign s_axi_rdata   = rdata_reg;

    // Internal submodules
    wire [31:0] line_centroid_q16;
    wire        sensor_saturated;
    wire        estop_tripped;
    wire        wdg_timeout;
    wire        internal_seu_alert;
    wire [31:0] safe_thrust_x;
    wire [31:0] safe_thrust_y;
    wire [31:0] safe_torque;

    assign estop_interlock_o   = estop_tripped;
    assign seu_alert_o         = internal_seu_alert;
    assign irq_o               = estop_tripped || internal_seu_alert || sensor_saturated;
    assign safe_thrust_cmd_x_o = safe_thrust_x;
    assign safe_thrust_cmd_y_o = safe_thrust_y;
    assign safe_torque_cmd_o   = safe_torque;

    line_sensor_filter u_filter (
        .clk(s_axi_aclk),
        .rst_n(s_axi_aresetn),
        .raw_adc_i(raw_sensor_adc_i),
        .line_centroid_q16_o(line_centroid_q16),
        .sensor_saturated_o(sensor_saturated)
    );

    safety_interlock #(
        .WATCHDOG_TIMEOUT_CYCLES(32'd50000)
    ) u_interlock (
        .clk(s_axi_aclk),
        .rst_n(s_axi_aresetn),
        .system_enable_i(reg_cr_ctrl[0]),
        .wdg_kick_i(wdg_kick_pulse),
        .manual_estop_i(reg_cr_ctrl[1]),
        .chaos_seu_inject_i(reg_chaos_fault_inj[0]),
        .command_write_strobe_i(command_write_pulse),
        .thrust_x_cmd_i(reg_thrust_cmd_x),
        .thrust_y_cmd_i(reg_thrust_cmd_y),
        .torque_cmd_i(reg_torque_cmd),
        .safety_limit_i(reg_safety_limit),
        .estop_tripped_o(estop_tripped),
        .wdg_timeout_o(wdg_timeout),
        .seu_alert_o(internal_seu_alert),
        .safe_thrust_x_o(safe_thrust_x),
        .safe_thrust_y_o(safe_thrust_y),
        .safe_torque_o(safe_torque)
    );

    rcs_thruster_pwm u_pwm (
        .clk(s_axi_aclk),
        .rst_n(s_axi_aresetn),
        .estop_tripped_i(estop_tripped),
        .cmd_thrust_x_i(safe_thrust_x),
        .cmd_thrust_y_i(safe_thrust_y),
        .cmd_torque_i(safe_torque),
        .thruster_pwm_o(thruster_pwm_o)
    );

    // AXI Write logic
    always @(posedge s_axi_aclk or negedge s_axi_aresetn) begin
        if (!s_axi_aresetn) begin
            awready_reg         <= 1'b0;
            wready_reg          <= 1'b0;
            bvalid_reg          <= 1'b0;
            reg_cr_ctrl         <= 32'd0;
            reg_thrust_cmd_x    <= 32'd0;
            reg_thrust_cmd_y    <= 32'd0;
            reg_thrust_cmd_z    <= 32'd0;
            reg_torque_cmd      <= 32'd0;
            reg_safety_limit    <= 32'h0000FFFF; // Default limit
            reg_chaos_fault_inj <= 32'd0;
            reg_wheel_torque_cmd <= 32'd0;
            wdg_kick_pulse      <= 1'b0;
            command_write_pulse <= 1'b0;
        end else begin
            wdg_kick_pulse      <= 1'b0;
            command_write_pulse <= 1'b0;

            if (~awready_reg && s_axi_awvalid && s_axi_wvalid) begin
                awready_reg <= 1'b1;
                wready_reg  <= 1'b1;
            end else begin
                awready_reg <= 1'b0;
                wready_reg  <= 1'b0;
            end

            if (awready_reg && s_axi_awvalid && wready_reg && s_axi_wvalid) begin
                bvalid_reg <= 1'b1;
                case (s_axi_awaddr[5:0])
                    ADDR_CR_CTRL:          reg_cr_ctrl          <= s_axi_wdata;
                    ADDR_THRUST_CMD_X:     begin reg_thrust_cmd_x <= s_axi_wdata; command_write_pulse <= 1'b1; end
                    ADDR_THRUST_CMD_Y:     begin reg_thrust_cmd_y <= s_axi_wdata; command_write_pulse <= 1'b1; end
                    ADDR_THRUST_CMD_Z:     reg_thrust_cmd_z     <= s_axi_wdata;
                    ADDR_TORQUE_CMD:       begin reg_torque_cmd   <= s_axi_wdata; command_write_pulse <= 1'b1; end
                    ADDR_SAFETY_LIMIT:     reg_safety_limit     <= s_axi_wdata;
                    ADDR_WATCHDOG_KICK:    wdg_kick_pulse       <= 1'b1;
                    ADDR_CHAOS_FAULT_INJ:  reg_chaos_fault_inj  <= s_axi_wdata;
                    ADDR_WHEEL_TORQUE_CMD: reg_wheel_torque_cmd <= s_axi_wdata;
                    default: ;
                endcase
            end else if (s_axi_bready && bvalid_reg) begin
                bvalid_reg <= 1'b0;
            end
        end
    end

    // AXI Read logic
    always @(posedge s_axi_aclk or negedge s_axi_aresetn) begin
        if (!s_axi_aresetn) begin
            arready_reg <= 1'b0;
            rvalid_reg  <= 1'b0;
            rdata_reg   <= 32'd0;
        end else begin
            if (~arready_reg && s_axi_arvalid) begin
                arready_reg <= 1'b1;
            end else begin
                arready_reg <= 1'b0;
            end

            if (arready_reg && s_axi_arvalid) begin
                rvalid_reg <= 1'b1;
                case (s_axi_araddr[5:0])
                    ADDR_CR_CTRL:          rdata_reg <= reg_cr_ctrl;
                    ADDR_SR_STATUS:        rdata_reg <= {28'd0, wdg_timeout, internal_seu_alert, estop_tripped, reg_cr_ctrl[0]};
                    ADDR_SENSOR_RAW:       rdata_reg <= raw_sensor_adc_i;
                    ADDR_SENSOR_EDGE:      rdata_reg <= line_centroid_q16;
                    ADDR_THRUST_CMD_X:     rdata_reg <= reg_thrust_cmd_x;
                    ADDR_THRUST_CMD_Y:     rdata_reg <= reg_thrust_cmd_y;
                    ADDR_THRUST_CMD_Z:     rdata_reg <= reg_thrust_cmd_z;
                    ADDR_TORQUE_CMD:       rdata_reg <= reg_torque_cmd;
                    ADDR_SAFETY_LIMIT:     rdata_reg <= reg_safety_limit;
                    ADDR_CHAOS_FAULT_INJ:  rdata_reg <= reg_chaos_fault_inj;
                    ADDR_WHEEL_TORQUE_CMD: rdata_reg <= reg_wheel_torque_cmd;
                    default:               rdata_reg <= 32'hDEADBEEF;
                endcase
            end else if (s_axi_rready && rvalid_reg) begin
                rvalid_reg <= 1'b0;
            end
        end
    end

endmodule
