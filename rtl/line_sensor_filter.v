// line_sensor_filter.v
// 8-channel optical line sensor ADC filter and centroid calculator
`timescale 1ns / 1ps

module line_sensor_filter (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [31:0] raw_adc_i,         // 8 channels x 4-bit ADC values
    output reg  [31:0] line_centroid_q16_o,// Fixed-point Q16.16 centroid (-1.0 to +1.0)
    output reg         sensor_saturated_o  // Solar glare / all saturated alert
);

    wire [3:0] ch0 = raw_adc_i[3:0];
    wire [3:0] ch1 = raw_adc_i[7:4];
    wire [3:0] ch2 = raw_adc_i[11:8];
    wire [3:0] ch3 = raw_adc_i[15:12];
    wire [3:0] ch4 = raw_adc_i[19:16];
    wire [3:0] ch5 = raw_adc_i[23:20];
    wire [3:0] ch6 = raw_adc_i[27:24];
    wire [3:0] ch7 = raw_adc_i[31:28];

    reg [11:0] sum_weights;
    reg [15:0] weighted_pos;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            line_centroid_q16_o <= 32'sd0;
            sensor_saturated_o  <= 1'b0;
            sum_weights         <= 12'd0;
            weighted_pos        <= 16'd0;
        end else begin
            // Detect saturation
            if (ch0 > 4'd13 && ch1 > 4'd13 && ch2 > 4'd13 && ch3 > 4'd13 &&
                ch4 > 4'd13 && ch5 > 4'd13 && ch6 > 4'd13 && ch7 > 4'd13) begin
                sensor_saturated_o <= 1'b1;
            end else begin
                sensor_saturated_o <= 1'b0;
            end

            sum_weights <= {8'd0, ch0} + {8'd0, ch1} + {8'd0, ch2} + {8'd0, ch3} +
                           {8'd0, ch4} + {8'd0, ch5} + {8'd0, ch6} + {8'd0, ch7};

            weighted_pos <= ({12'd0, ch0} * 16'd0) + ({12'd0, ch1} * 16'd1) +
                            ({12'd0, ch2} * 16'd2) + ({12'd0, ch3} * 16'd3) +
                            ({12'd0, ch4} * 16'd4) + ({12'd0, ch5} * 16'd5) +
                            ({12'd0, ch6} * 16'd6) + ({12'd0, ch7} * 16'd7);

            if (sum_weights > 12'd8) begin
                line_centroid_q16_o <= (({16'd0, weighted_pos} << 16) / {20'd0, sum_weights}) - 32'd229376;
            end else begin
                line_centroid_q16_o <= 32'sd0;
            end
        end
    end

endmodule
