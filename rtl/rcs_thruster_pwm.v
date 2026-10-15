// rcs_thruster_pwm.v
// 8-channel RCS pulse-width modulator with signed Q16.16 duty conversion and saturation
`timescale 1ns / 1ps

module rcs_thruster_pwm (
    input  wire        clk,
    input  wire        rst_n,
    input  wire        estop_tripped_i,
    input  wire [31:0] cmd_thrust_x_i, // Signed Q16.16: -1.0 to +1.0 (Full scale = 0x00010000)
    input  wire [31:0] cmd_thrust_y_i, // Signed Q16.16: -1.0 to +1.0
    input  wire [31:0] cmd_torque_i,   // Signed Q16.16: -1.0 to +1.0
    output reg  [7:0]  thruster_pwm_o
);

    reg [7:0] pwm_counter;

    // Helper function for signed Q16.16 to 8-bit PWM duty conversion (0..255)
    function [7:0] q16_to_duty;
        input [31:0] q16_val;
        reg [31:0] abs_val;
        begin
            abs_val = q16_val[31] ? (-q16_val) : q16_val;
            // If integer part >= 1.0 (bit 16 or higher is set), saturate to 100% duty (255)
            if (|abs_val[30:16]) begin
                q16_to_duty = 8'hFF;
            end else begin
                q16_to_duty = abs_val[15:8];
            end
        end
    endfunction

    wire [7:0] duty_x      = q16_to_duty(cmd_thrust_x_i);
    wire [7:0] duty_y      = q16_to_duty(cmd_thrust_y_i);
    wire [7:0] duty_torque = q16_to_duty(cmd_torque_i);

    wire is_fwd_x = (~cmd_thrust_x_i[31]) && (cmd_thrust_x_i != 32'd0);
    wire is_aft_x = cmd_thrust_x_i[31];

    wire is_port_y = (~cmd_thrust_y_i[31]) && (cmd_thrust_y_i != 32'd0);
    wire is_stbd_y = cmd_thrust_y_i[31];

    wire is_ccw_torque = (~cmd_torque_i[31]) && (cmd_torque_i != 32'd0);
    wire is_cw_torque  = cmd_torque_i[31];

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            pwm_counter    <= 8'd0;
            thruster_pwm_o <= 8'd0;
        end else begin
            pwm_counter <= pwm_counter + 1'b1;

            if (estop_tripped_i) begin
                thruster_pwm_o <= 8'd0; // Instant safe cutoff
            end else begin
                // Simple 8-nozzle allocation based on X/Y thrust and torque
                // Bit 0, 1: +X / -X main thrusters
                // Bit 2, 3: +Y / -Y lateral thrusters
                // Bit 4, 5: +Z / -Z vertical downforce
                // Bit 6, 7: +Yaw / -Yaw rotational thrusters
                thruster_pwm_o[0] <= is_fwd_x && (duty_x > pwm_counter);
                thruster_pwm_o[1] <= is_aft_x && (duty_x > pwm_counter);
                thruster_pwm_o[2] <= is_port_y && (duty_y > pwm_counter);
                thruster_pwm_o[3] <= is_stbd_y && (duty_y > pwm_counter);
                thruster_pwm_o[4] <= 1'b1; // Continuous microgravity downforce (Stage 1)
                thruster_pwm_o[5] <= 1'b0;
                thruster_pwm_o[6] <= is_ccw_torque && (duty_torque > pwm_counter);
                thruster_pwm_o[7] <= is_cw_torque && (duty_torque > pwm_counter);
            end
        end
    end

endmodule
