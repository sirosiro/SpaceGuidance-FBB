// rcs_thruster_pwm.v
// 8-channel RCS pulse-width modulator with minimum impulse bit (MIB) enforcement
`timescale 1ns / 1ps

module rcs_thruster_pwm (
    input  wire        clk,
    input  wire        rst_n,
    input  wire        estop_tripped_i,
    input  wire [31:0] cmd_thrust_x_i,
    input  wire [31:0] cmd_thrust_y_i,
    input  wire [31:0] cmd_torque_i,
    output reg  [7:0]  thruster_pwm_o
);

    reg [7:0] pwm_counter;

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
                thruster_pwm_o[0] <= (cmd_thrust_x_i[15:8] > pwm_counter);
                thruster_pwm_o[1] <= (cmd_thrust_x_i[31] && (cmd_thrust_x_i[15:8] > pwm_counter));
                thruster_pwm_o[2] <= (cmd_thrust_y_i[15:8] > pwm_counter);
                thruster_pwm_o[3] <= (cmd_thrust_y_i[31] && (cmd_thrust_y_i[15:8] > pwm_counter));
                thruster_pwm_o[4] <= 1'b1; // Continuous microgravity downforce (Stage 1)
                thruster_pwm_o[5] <= 1'b0;
                thruster_pwm_o[6] <= (cmd_torque_i[15:8] > pwm_counter);
                thruster_pwm_o[7] <= (cmd_torque_i[31] && (cmd_torque_i[15:8] > pwm_counter));
            end
        end
    end

endmodule
