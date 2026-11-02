#pragma once

#include <stdbool.h>
#include "driver/gpio.h"
#include "esp_err.h"


esp_err_t rgb_led_init(gpio_num_t red, gpio_num_t green, gpio_num_t blue);
esp_err_t rgb_led_set_power(bool power);
esp_err_t rgb_led_set_brightness(uint8_t matter_level);
esp_err_t rgb_led_set_rgb(uint8_t red, uint8_t green, uint8_t blue);
esp_err_t rgb_led_set_hsv(uint8_t hue, uint8_t saturation);
esp_err_t rgb_led_set_xy(uint16_t x, uint16_t y);
esp_err_t rgb_led_set_color_temperature(uint16_t mireds);
