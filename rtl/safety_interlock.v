// safety_interlock.v
// Watchdog timer, multi-axis SEU parity monitor, and emergency E-STOP interlock
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
    input  wire        thrust_write_strobe_i, // Asserted on CPU AXI register write to X or Y
    input  wire [31:0] thrust_x_cmd_i,        // Signed Q16.16 X thrust command
    input  wire [31:0] thrust_y_cmd_i,        // Signed Q16.16 Y thrust command
    input  wire [31:0] safety_limit_i,        // Unsigned Q16.16 maximum allowable magnitude
    output reg         estop_tripped_o,
    output reg         wdg_timeout_o,
    output reg         seu_alert_o,
    output reg  [31:0] safe_thrust_x_o,
    output reg  [31:0] safe_thrust_y_o
);

    reg [31:0] wdg_counter;
    reg        stored_parity;
    wire       current_parity = (^thrust_x_cmd_i) ^ (^thrust_y_cmd_i);

    // Signed magnitude check for bipolar thrust on X and Y axes
    wire signed [31:0] signed_x = thrust_x_cmd_i;
    wire [31:0]        abs_x    = signed_x[31] ? (-signed_x) : signed_x;
    wire               over_x   = (abs_x > safety_limit_i);

    wire signed [31:0] signed_y = thrust_y_cmd_i;
    wire [31:0]        abs_y    = signed_y[31] ? (-signed_y) : signed_y;
    wire               over_y   = (abs_y > safety_limit_i);

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            wdg_counter     <= WATCHDOG_TIMEOUT_CYCLES;
            wdg_timeout_o   <= 1'b0;
            estop_tripped_o <= 1'b0;
            seu_alert_o     <= 1'b0;
            stored_parity   <= 1'b0;
            safe_thrust_x_o <= 32'd0;
            safe_thrust_y_o <= 32'd0;
        end else begin
            // 1. Hardware Register Parity / SEU Monitoring
            // When CPU writes new data, update stored parity simultaneously.
            // In all other cycles, if current parity deviates from stored parity (or chaos injected), trip SEU.
            if (thrust_write_strobe_i) begin
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

            // 3. Emergency stop evaluation & Safe thrust clamping for X and Y axes
            if (manual_estop_i || wdg_timeout_o || seu_alert_o || !system_enable_i) begin
                estop_tripped_o <= 1'b1;
                safe_thrust_x_o <= 32'd0; // Immediate cutoff
                safe_thrust_y_o <= 32'd0;
            end else begin
                estop_tripped_o <= 1'b0;
                // Clamp bidirectional X thrust magnitude
                if (over_x) begin
                    safe_thrust_x_o <= signed_x[31] ? (-safety_limit_i) : safety_limit_i;
                end else begin
                    safe_thrust_x_o <= thrust_x_cmd_i;
                end
                // Clamp bidirectional Y thrust magnitude
                if (over_y) begin
                    safe_thrust_y_o <= signed_y[31] ? (-safety_limit_i) : safety_limit_i;
                end else begin
                    safe_thrust_y_o <= thrust_y_cmd_i;
                end
            end
        end
    end

endmodule
