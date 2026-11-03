// safety_interlock.v
// Watchdog timer, 5-axis independent SEU parity monitor, and emergency E-STOP interlock
`timescale 1ns / 1ps

module safety_interlock #(
    parameter WATCHDOG_TIMEOUT_CYCLES = 32'd1000000 // e.g. 10ms at 100MHz
)(
    input  wire        clk,
    input  wire        rst_n,
    input  wire        system_enable_i,
    input  wire        wdg_kick_i,
    input  wire        manual_estop_i,
    input  wire        chaos_seu_inject_i,
    input  wire        command_write_strobe_i, // Asserted on CPU AXI register write to any actuator command
    input  wire [31:0] thrust_x_cmd_i,         // Signed Q16.16 X thrust command
    input  wire [31:0] thrust_y_cmd_i,         // Signed Q16.16 Y thrust command
    input  wire [31:0] thrust_z_cmd_i,         // Signed Q16.16 Z thrust command (Vertical)
    input  wire [31:0] torque_cmd_i,           // Signed Q16.16 Torque command (RCS Yaw)
    input  wire [31:0] wheel_torque_cmd_i,     // Signed Q16.16 Reaction Wheel Torque command
    input  wire [31:0] safety_limit_i,         // Unsigned Q16.16 maximum allowable magnitude
    output reg         estop_tripped_o,
    output reg         wdg_timeout_o,
    output reg         seu_alert_o,
    output reg  [31:0] safe_thrust_x_o,
    output reg  [31:0] safe_thrust_y_o,
    output reg  [31:0] safe_thrust_z_o,
    output reg  [31:0] safe_torque_o,
    output reg  [31:0] safe_wheel_torque_o
);

    reg [31:0] wdg_counter;

    // Independent 5-bit parity monitoring (one bit per register: Wheel Torque, Z, Torque, Y, X)
    // Eliminates composite XOR cancellation so multi-register simultaneous flips are reliably trapped.
    reg [4:0]  stored_parity;
    wire [4:0] current_parity = {^wheel_torque_cmd_i, ^thrust_z_cmd_i, ^torque_cmd_i, ^thrust_y_cmd_i, ^thrust_x_cmd_i};

    // Signed magnitude check for bipolar thrust and torque across all 5 actuator channels
    wire signed [31:0] signed_x = thrust_x_cmd_i;
    wire [31:0]        abs_x    = signed_x[31] ? (-signed_x) : signed_x;
    wire               over_x   = (abs_x > safety_limit_i);

    wire signed [31:0] signed_y = thrust_y_cmd_i;
    wire [31:0]        abs_y    = signed_y[31] ? (-signed_y) : signed_y;
    wire               over_y   = (abs_y > safety_limit_i);

    wire signed [31:0] signed_z = thrust_z_cmd_i;
    wire [31:0]        abs_z    = signed_z[31] ? (-signed_z) : signed_z;
    wire               over_z   = (abs_z > safety_limit_i);

    wire signed [31:0] signed_torque = torque_cmd_i;
    wire [31:0]        abs_torque    = signed_torque[31] ? (-signed_torque) : signed_torque;
    wire               over_torque   = (abs_torque > safety_limit_i);

    wire signed [31:0] signed_wheel  = wheel_torque_cmd_i;
    wire [31:0]        abs_wheel     = signed_wheel[31] ? (-signed_wheel) : signed_wheel;
    wire               over_wheel    = (abs_wheel > safety_limit_i);

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            wdg_counter         <= WATCHDOG_TIMEOUT_CYCLES;
            wdg_timeout_o       <= 1'b0;
            estop_tripped_o     <= 1'b0;
            seu_alert_o         <= 1'b0;
            stored_parity       <= 5'b00000;
            safe_thrust_x_o     <= 32'd0;
            safe_thrust_y_o     <= 32'd0;
            safe_thrust_z_o     <= 32'd0;
            safe_torque_o       <= 32'd0;
            safe_wheel_torque_o <= 32'd0;
        end else begin
            // 1. Hardware Register Parity / SEU Monitoring across all 5 actuator channels
            if (command_write_strobe_i) begin
                stored_parity <= current_parity;
                seu_alert_o   <= chaos_seu_inject_i;
            end else if (chaos_seu_inject_i) begin
                seu_alert_o   <= 1'b1;
            end else if (system_enable_i && (current_parity != stored_parity)) begin
                seu_alert_o   <= 1'b1; // Spontaneous bitflip detected without CPU write
            end

            // 2. Watchdog countdown
            if (wdg_kick_i) begin
                wdg_counter   <= WATCHDOG_TIMEOUT_CYCLES;
                wdg_timeout_o <= 1'b0;
            end else if (system_enable_i) begin
                if (wdg_counter > 0) begin
                    wdg_counter <= wdg_counter - 1'b1;
                end else begin
                    wdg_timeout_o <= 1'b1;
                end
            end

            // 3. Emergency stop evaluation & Safe command clamping for all 5 channels
            if (manual_estop_i || wdg_timeout_o || seu_alert_o || !system_enable_i) begin
                estop_tripped_o     <= 1'b1;
                safe_thrust_x_o     <= 32'd0; // Immediate cutoff: all actuators safe
                safe_thrust_y_o     <= 32'd0;
                safe_thrust_z_o     <= 32'd0;
                safe_torque_o       <= 32'd0;
                safe_wheel_torque_o <= 32'd0;
            end else begin
                estop_tripped_o <= 1'b0;
                // Clamp bidirectional X thrust magnitude
                safe_thrust_x_o <= over_x ? (signed_x[31] ? (-safety_limit_i) : safety_limit_i) : thrust_x_cmd_i;
                // Clamp bidirectional Y thrust magnitude
                safe_thrust_y_o <= over_y ? (signed_y[31] ? (-safety_limit_i) : safety_limit_i) : thrust_y_cmd_i;
                // Clamp bidirectional Z thrust magnitude
                safe_thrust_z_o <= over_z ? (signed_z[31] ? (-safety_limit_i) : safety_limit_i) : thrust_z_cmd_i;
                // Clamp bidirectional Torque magnitude
                safe_torque_o   <= over_torque ? (signed_torque[31] ? (-safety_limit_i) : safety_limit_i) : torque_cmd_i;
                // Clamp bidirectional Reaction Wheel Torque magnitude
                safe_wheel_torque_o <= over_wheel ? (signed_wheel[31] ? (-safety_limit_i) : safety_limit_i) : wheel_torque_cmd_i;
            end
        end
    end

endmodule
