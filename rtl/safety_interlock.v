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
    input  wire [31:0] thrust_cmd_i,
    input  wire [31:0] safety_limit_i,
    output reg         estop_tripped_o,
    output reg         wdg_timeout_o,
    output reg         seu_alert_o,
    output reg  [31:0] safe_thrust_cmd_o
);

    reg [31:0] wdg_counter;
    reg parity_expected;
    wire parity_actual = ^thrust_cmd_i;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            wdg_counter       <= WATCHDOG_TIMEOUT_CYCLES;
            wdg_timeout_o     <= 1'b0;
            estop_tripped_o   <= 1'b0;
            seu_alert_o       <= 1'b0;
            parity_expected   <= 1'b0;
            safe_thrust_cmd_o <= 32'd0;
        end else begin
            // Parity check
            if (chaos_seu_inject_i) begin
                seu_alert_o <= 1'b1; // Simulate corrupted register
            end else begin
                parity_expected <= parity_actual;
                seu_alert_o <= (parity_actual != parity_expected) && system_enable_i;
            end

            // Watchdog countdown
            if (wdg_kick_i) begin
                wdg_counter <= WATCHDOG_TIMEOUT_CYCLES;
                wdg_timeout_o <= 1'b0;
            end else if (system_enable_i) begin
                if (wdg_counter > 0) begin
                    wdg_counter <= wdg_counter - 1'b1;
                end else begin
                    wdg_timeout_o <= 1'b1;
                end
            end

            // Emergency stop evaluation
            if (manual_estop_i || wdg_timeout_o || seu_alert_o || !system_enable_i) begin
                estop_tripped_o   <= 1'b1;
                safe_thrust_cmd_o <= 32'd0; // Immediate cutoff
            end else begin
                estop_tripped_o <= 1'b0;
                // Clamp thrust to safety limit
                if (thrust_cmd_i > safety_limit_i) begin
                    safe_thrust_cmd_o <= safety_limit_i;
                end else begin
                    safe_thrust_cmd_o <= thrust_cmd_i;
                end
            end
        end
    end

endmodule
