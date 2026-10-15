// safety_interlock.v
// Watchdog timer, SEU parity monitor, and emergency E-STOP interlock
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
    input  wire        thrust_write_strobe_i, // Asserted on CPU AXI register write
    input  wire [31:0] thrust_cmd_i,          // Signed Q16.16 thrust command
    input  wire [31:0] safety_limit_i,        // Unsigned Q16.16 maximum allowable magnitude
    output reg         estop_tripped_o,
    output reg         wdg_timeout_o,
    output reg         seu_alert_o,
    output reg  [31:0] safe_thrust_cmd_o
);

    reg [31:0] wdg_counter;
    reg        stored_parity;
    wire       current_parity = ^thrust_cmd_i;

    // Signed magnitude check for bipolar thrust
    wire signed [31:0] signed_cmd = thrust_cmd_i;
    wire [31:0]        abs_thrust = signed_cmd[31] ? (-signed_cmd) : signed_cmd;
    wire               over_limit = (abs_thrust > safety_limit_i);

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            wdg_counter       <= WATCHDOG_TIMEOUT_CYCLES;
            wdg_timeout_o     <= 1'b0;
            estop_tripped_o   <= 1'b0;
            seu_alert_o       <= 1'b0;
            stored_parity     <= 1'b0;
            safe_thrust_cmd_o <= 32'd0;
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

            // 3. Emergency stop evaluation & Safe thrust clamping
            if (manual_estop_i || wdg_timeout_o || seu_alert_o || !system_enable_i) begin
                estop_tripped_o   <= 1'b1;
                safe_thrust_cmd_o <= 32'd0; // Immediate cutoff
            end else begin
                estop_tripped_o <= 1'b0;
                // Clamp bidirectional thrust magnitude to safety_limit preserving sign
                if (over_limit) begin
                    safe_thrust_cmd_o <= signed_cmd[31] ? (-safety_limit_i) : safety_limit_i;
                end else begin
                    safe_thrust_cmd_o <= thrust_cmd_i;
                end
            end
        end
    end

endmodule
