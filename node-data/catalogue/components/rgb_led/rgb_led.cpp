#include "rgb_led.h"

#include <math.h>
#include <stdio.h>
#include <stdint.h>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_err.h"
#include "esp_log.h"
#include "soc/soc_caps.h"

#if !SOC_LEDC_SUPPORTED || SOC_LEDC_CHANNEL_NUM < 3 || SOC_LEDC_TIMER_NUM < 1
#error This RGB driver requires the ESP32-H2 LEDC peripheral: at least three channels and one timer.
#endif
#if defined(SOC_LEDC_SUPPORT_HS_MODE)
#error ESP32-H2 LEDC is low-speed only. Do not compile this driver for a high-speed LEDC target.
#endif

static const char *TAG = "rgb_led";

#define RGB_PWM_MODE LEDC_LOW_SPEED_MODE
#define RGB_PWM_TIMER LEDC_TIMER_0
#define RGB_PWM_FREQ_HZ 5000
#define RGB_PWM_RESOLUTION LEDC_TIMER_8_BIT
#define RGB_PWM_CLOCK LEDC_USE_XTAL_CLK
#define RGB_PWM_DUTY_MAX ((1U << 8) - 1U)

#define RGB_RED_CHANNEL LEDC_CHANNEL_0
#define RGB_GREEN_CHANNEL LEDC_CHANNEL_1
#define RGB_BLUE_CHANNEL LEDC_CHANNEL_2

static gpio_num_t red_gpio = GPIO_NUM_4;
static gpio_num_t green_gpio = GPIO_NUM_10;
static gpio_num_t blue_gpio = GPIO_NUM_5;
static bool current_power = true;
static uint8_t current_brightness = 254;
static uint8_t current_hue = 0;
static uint8_t current_saturation = 254;
static uint16_t current_x = 0;
static uint16_t current_y = 0;
static uint8_t current_red = 0;
static uint8_t current_green = 255;
static uint8_t current_blue = 0;
static bool pwm_ready = false;

static bool reserved_gpio(gpio_num_t pin)
{
    return pin < GPIO_NUM_0 || pin > GPIO_NUM_27 || pin == GPIO_NUM_8 || pin == GPIO_NUM_9;
}

static esp_err_t record_ledc(const char *function_name, esp_err_t err, const char *parameters)
{
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "%s ok. %s", function_name, parameters);
        return err;
    }
    ESP_LOGE(TAG, "%s failed: %s (%d). %s", function_name, esp_err_to_name(err), err, parameters);
    return err;
}

static void release_pwm(void)
{
    ledc_stop(RGB_PWM_MODE, RGB_RED_CHANNEL, 0);
    ledc_stop(RGB_PWM_MODE, RGB_GREEN_CHANNEL, 0);
    ledc_stop(RGB_PWM_MODE, RGB_BLUE_CHANNEL, 0);
    ledc_timer_pause(RGB_PWM_MODE, RGB_PWM_TIMER);
    ledc_timer_config_t timer_config = {};
    timer_config.speed_mode = RGB_PWM_MODE;
    timer_config.timer_num = RGB_PWM_TIMER;
    timer_config.deconfigure = true;
    esp_err_t err = ledc_timer_config(&timer_config);
    record_ledc("ledc_timer_config deconfigure", err, "mode=low-speed timer=0");
    pwm_ready = false;
}

static esp_err_t configure_pwm_channel(gpio_num_t gpio_num, ledc_channel_t channel)
{
    if (!GPIO_IS_VALID_OUTPUT_GPIO(gpio_num)) {
        ESP_LOGE(TAG, "GPIO %d is not a valid ESP32-H2 output", static_cast<int>(gpio_num));
        return ESP_ERR_INVALID_ARG;
    }
    ledc_channel_config_t channel_config = {};
    channel_config.gpio_num = gpio_num;
    channel_config.speed_mode = RGB_PWM_MODE;
    channel_config.channel = channel;
    channel_config.intr_type = LEDC_INTR_DISABLE;
    channel_config.timer_sel = RGB_PWM_TIMER;
    channel_config.duty = 0;
    channel_config.hpoint = 0;
    channel_config.sleep_mode = LEDC_SLEEP_MODE_NO_ALIVE_NO_PD;
    channel_config.flags.output_invert = 0;
    char parameters[96];
    snprintf(parameters, sizeof(parameters), "gpio=%d channel=%d mode=low-speed timer=0 duty=0 invert=0",
             static_cast<int>(gpio_num), static_cast<int>(channel));
    return record_ledc("ledc_channel_config", ledc_channel_config(&channel_config), parameters);
}

static esp_err_t set_pwm_channel(ledc_channel_t channel, uint8_t value)
{
    if (!pwm_ready) return ESP_ERR_INVALID_STATE;
    const uint32_t duty = value > RGB_PWM_DUTY_MAX ? RGB_PWM_DUTY_MAX : value;
    esp_err_t err = ledc_set_duty(RGB_PWM_MODE, channel, duty);
    if (err != ESP_OK) return record_ledc("ledc_set_duty", err, "mode=low-speed");
    err = ledc_update_duty(RGB_PWM_MODE, channel);
    if (err != ESP_OK) return record_ledc("ledc_update_duty", err, "mode=low-speed");
    return ESP_OK;
}

static esp_err_t apply_rgb(void)
{
    uint8_t red = 0;
    uint8_t green = 0;
    uint8_t blue = 0;
    if (current_power) {
        red = ((uint16_t)current_red * current_brightness) / 255;
        green = ((uint16_t)current_green * current_brightness) / 255;
        blue = ((uint16_t)current_blue * current_brightness) / 255;
    }
    esp_err_t err = set_pwm_channel(RGB_RED_CHANNEL, red);
    if (err != ESP_OK) return err;
    err = set_pwm_channel(RGB_GREEN_CHANNEL, green);
    if (err != ESP_OK) return err;
    err = set_pwm_channel(RGB_BLUE_CHANNEL, blue);
    if (err != ESP_OK) return err;
    ESP_LOGI(TAG, "Applied RGB: R=%u G=%u B=%u brightness=%u power=%s", red, green, blue, current_brightness, current_power ? "ON" : "OFF");
    return ESP_OK;
}

static uint8_t matter_level_to_brightness(uint8_t matter_level)
{
    return (uint8_t)(((uint16_t)matter_level * 255) / 254);
}

static uint8_t clamp_float_to_u8(float value)
{
    if (value <= 0.0f) return 0;
    if (value >= 255.0f) return 255;
    return (uint8_t)(value + 0.5f);
}

static float gamma_correct(float value)
{
    if (value <= 0.0f) return 0.0f;
    if (value >= 1.0f) return 1.0f;
    if (value <= 0.0031308f) return 12.92f * value;
    return (1.055f * powf(value, 1.0f / 2.4f)) - 0.055f;
}

static void hsv_to_rgb(uint8_t hue, uint8_t saturation, uint8_t value, uint8_t *red, uint8_t *green, uint8_t *blue)
{
    float h = ((float)hue / 254.0f) * 360.0f;
    float s = (float)saturation / 254.0f;
    float v = (float)value / 255.0f;
    float c = v * s;
    float x = c * (1.0f - fabsf(fmodf(h / 60.0f, 2.0f) - 1.0f));
    float m = v - c;
    float r1 = 0.0f;
    float g1 = 0.0f;
    float b1 = 0.0f;
    if (h < 60.0f) {
        r1 = c;
        g1 = x;
    } else if (h < 120.0f) {
        r1 = x;
        g1 = c;
    } else if (h < 180.0f) {
        g1 = c;
        b1 = x;
    } else if (h < 240.0f) {
        g1 = x;
        b1 = c;
    } else if (h < 300.0f) {
        r1 = x;
        b1 = c;
    } else {
        r1 = c;
        b1 = x;
    }
    *red = clamp_float_to_u8(gamma_correct(r1 + m) * 255.0f);
    *green = clamp_float_to_u8(gamma_correct(g1 + m) * 255.0f);
    *blue = clamp_float_to_u8(gamma_correct(b1 + m) * 255.0f);
}

static void xy_to_rgb(uint16_t matter_x, uint16_t matter_y, uint8_t *red, uint8_t *green, uint8_t *blue)
{
    float x = (float)matter_x / 65535.0f;
    float y = (float)matter_y / 65535.0f;
    if (y <= 0.0f) {
        *red = 255;
        *green = 255;
        *blue = 255;
        return;
    }
    float Y = 1.0f;
    float X = (Y / y) * x;
    float Z = (Y / y) * (1.0f - x - y);
    float r = (X * 1.656492f) + (Y * -0.354851f) + (Z * -0.255038f);
    float g = (X * -0.707196f) + (Y * 1.655397f) + (Z * 0.036152f);
    float b = (X * 0.051713f) + (Y * -0.121364f) + (Z * 1.011530f);
    if (r < 0.0f) r = 0.0f;
    if (g < 0.0f) g = 0.0f;
    if (b < 0.0f) b = 0.0f;
    float max_channel = r;
    if (g > max_channel) max_channel = g;
    if (b > max_channel) max_channel = b;
    if (max_channel > 1.0f) {
        r /= max_channel;
        g /= max_channel;
        b /= max_channel;
    }
    *red = clamp_float_to_u8(gamma_correct(r) * 255.0f);
    *green = clamp_float_to_u8(gamma_correct(g) * 255.0f);
    *blue = clamp_float_to_u8(gamma_correct(b) * 255.0f);
}

static void mireds_to_rgb(uint16_t mireds, uint8_t *red, uint8_t *green, uint8_t *blue)
{
    if (mireds < 153) mireds = 153;
    if (mireds > 500) mireds = 500;
    float kelvin = 1000000.0f / (float)mireds;
    float scaled = kelvin / 100.0f;
    float r = kelvin <= 6600.0f ? 255.0f : 329.698727446f * powf(scaled - 60.0f, -0.1332047592f);
    float g = kelvin <= 6600.0f ? 99.4708025861f * logf(scaled) - 161.1195681661f : 288.1221695283f * powf(scaled - 60.0f, -0.0755148492f);
    float b = kelvin >= 6600.0f ? 255.0f : kelvin <= 1900.0f ? 0.0f : 138.5177312231f * logf(scaled - 10.0f) - 305.0447927307f;
    *red = clamp_float_to_u8(r);
    *green = clamp_float_to_u8(g);
    *blue = clamp_float_to_u8(b);
}

esp_err_t rgb_led_init(gpio_num_t red, gpio_num_t green, gpio_num_t blue)
{
    if (reserved_gpio(red) || reserved_gpio(green) || reserved_gpio(blue) || red == green || red == blue || green == blue) {
        ESP_LOGE(TAG, "Rejected RGB pins R=%d G=%d B=%d. GPIO 8 and GPIO 9 stay reserved.", static_cast<int>(red), static_cast<int>(green), static_cast<int>(blue));
        return ESP_ERR_INVALID_ARG;
    }
    if (pwm_ready && red_gpio == red && green_gpio == green && blue_gpio == blue) {
        return ESP_OK;
    }
    if (pwm_ready) release_pwm();
    red_gpio = red;
    green_gpio = green;
    blue_gpio = blue;
    ledc_timer_config_t timer_config = {};
    timer_config.speed_mode = RGB_PWM_MODE;
    timer_config.duty_resolution = RGB_PWM_RESOLUTION;
    timer_config.timer_num = RGB_PWM_TIMER;
    timer_config.freq_hz = RGB_PWM_FREQ_HZ;
    timer_config.clk_cfg = RGB_PWM_CLOCK;
    timer_config.deconfigure = false;
    esp_err_t err = record_ledc("ledc_timer_config", ledc_timer_config(&timer_config), "mode=low-speed timer=0 freq_hz=5000 resolution=8 clock=XTAL");
    if (err != ESP_OK) return err;
    err = configure_pwm_channel(red_gpio, RGB_RED_CHANNEL);
    if (err != ESP_OK) {
        release_pwm();
        return err;
    }
    err = configure_pwm_channel(green_gpio, RGB_GREEN_CHANNEL);
    if (err != ESP_OK) {
        release_pwm();
        return err;
    }
    err = configure_pwm_channel(blue_gpio, RGB_BLUE_CHANNEL);
    if (err != ESP_OK) {
        release_pwm();
        return err;
    }
    pwm_ready = true;
    ESP_LOGI(TAG, "RGB LED initialised on R=GPIO%d G=GPIO%d B=GPIO%d", red_gpio, green_gpio, blue_gpio);
    err = apply_rgb();
    if (err != ESP_OK) release_pwm();
    return err;
}

esp_err_t rgb_led_set_power(bool power)
{
    current_power = power;
    return apply_rgb();
}

esp_err_t rgb_led_set_brightness(uint8_t matter_level)
{
    current_brightness = matter_level_to_brightness(matter_level);
    return apply_rgb();
}

esp_err_t rgb_led_set_rgb(uint8_t red, uint8_t green, uint8_t blue)
{
    current_red = red;
    current_green = green;
    current_blue = blue;
    return apply_rgb();
}

esp_err_t rgb_led_set_hsv(uint8_t hue, uint8_t saturation)
{
    current_hue = hue;
    current_saturation = saturation;
    hsv_to_rgb(current_hue, current_saturation, 255, &current_red, &current_green, &current_blue);
    return apply_rgb();
}

esp_err_t rgb_led_set_xy(uint16_t x, uint16_t y)
{
    current_x = x;
    current_y = y;
    xy_to_rgb(current_x, current_y, &current_red, &current_green, &current_blue);
    return apply_rgb();
}

esp_err_t rgb_led_set_color_temperature(uint16_t mireds)
{
    mireds_to_rgb(mireds, &current_red, &current_green, &current_blue);
    return apply_rgb();
}
