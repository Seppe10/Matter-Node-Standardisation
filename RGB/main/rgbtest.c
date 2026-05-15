#include <stdint.h>
#include <stdbool.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_err.h"
#include "esp_log.h"

// -----------------------------------------------------------------------------
// Pin setup
// -----------------------------------------------------------------------------
//
// Common-cathode RGB LED wiring:
//
// Common cathode pin -> GND
// Red leg   -> resistor -> GPIO4
// Green leg -> resistor -> GPIO5
// Blue leg  -> resistor -> GPIO10
//
// Use one resistor per colour leg, usually 220 ohm to 330 ohm.

#define RGB_RED_GPIO      4
#define RGB_GREEN_GPIO    5
#define RGB_BLUE_GPIO     10

// -----------------------------------------------------------------------------
// PWM setup
// -----------------------------------------------------------------------------

#define RGB_PWM_MODE       LEDC_LOW_SPEED_MODE
#define RGB_PWM_TIMER      LEDC_TIMER_0
#define RGB_PWM_FREQ_HZ    5000
#define RGB_PWM_RESOLUTION LEDC_TIMER_8_BIT

#define RGB_RED_CHANNEL    LEDC_CHANNEL_3
#define RGB_GREEN_CHANNEL  LEDC_CHANNEL_4
#define RGB_BLUE_CHANNEL   LEDC_CHANNEL_2

static const char *TAG = "RGB_TEST";

// -----------------------------------------------------------------------------
// Helper functions
// -----------------------------------------------------------------------------

static esp_err_t configure_pwm_channel(gpio_num_t gpio_num, ledc_channel_t channel)
{
    ledc_channel_config_t channel_config = {0};

    channel_config.gpio_num = gpio_num;
    channel_config.speed_mode = RGB_PWM_MODE;
    channel_config.channel = channel;
    channel_config.intr_type = LEDC_INTR_DISABLE;
    channel_config.timer_sel = RGB_PWM_TIMER;
    channel_config.duty = 0;
    channel_config.hpoint = 0;

    return ledc_channel_config(&channel_config);
}

static esp_err_t set_channel(ledc_channel_t channel, uint8_t value)
{
    // Common-cathode LED:
    // 0   = off
    // 255 = full brightness

    esp_err_t err = ledc_set_duty(RGB_PWM_MODE, channel, value);
    if (err != ESP_OK) {
        return err;
    }

    return ledc_update_duty(RGB_PWM_MODE, channel);
}

static esp_err_t set_rgb(uint8_t red, uint8_t green, uint8_t blue)
{
    esp_err_t err;

    err = set_channel(RGB_RED_CHANNEL, red);
    if (err != ESP_OK) {
        return err;
    }

    err = set_channel(RGB_GREEN_CHANNEL, green);
    if (err != ESP_OK) {
        return err;
    }

    err = set_channel(RGB_BLUE_CHANNEL, blue);
    if (err != ESP_OK) {
        return err;
    }

    ESP_LOGI(TAG, "RGB set to R=%u G=%u B=%u", red, green, blue);

    return ESP_OK;
}

static esp_err_t init_rgb_led(void)
{
    ledc_timer_config_t timer_config = {0};

    timer_config.speed_mode = RGB_PWM_MODE;
    timer_config.duty_resolution = RGB_PWM_RESOLUTION;
    timer_config.timer_num = RGB_PWM_TIMER;
    timer_config.freq_hz = RGB_PWM_FREQ_HZ;
    timer_config.clk_cfg = LEDC_AUTO_CLK;

    esp_err_t err = ledc_timer_config(&timer_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to configure LEDC timer: %s", esp_err_to_name(err));
        return err;
    }

    err = configure_pwm_channel((gpio_num_t)RGB_RED_GPIO, RGB_RED_CHANNEL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to configure red channel: %s", esp_err_to_name(err));
        return err;
    }

    err = configure_pwm_channel((gpio_num_t)RGB_GREEN_GPIO, RGB_GREEN_CHANNEL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to configure green channel: %s", esp_err_to_name(err));
        return err;
    }

    err = configure_pwm_channel((gpio_num_t)RGB_BLUE_GPIO, RGB_BLUE_CHANNEL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to configure blue channel: %s", esp_err_to_name(err));
        return err;
    }

    ESP_LOGI(TAG,
             "RGB LED initialised on R=GPIO%d G=GPIO%d B=GPIO%d",
             RGB_RED_GPIO,
             RGB_GREEN_GPIO,
             RGB_BLUE_GPIO);

    return set_rgb(0, 0, 0);
}

// -----------------------------------------------------------------------------
// RGB LED test sequence
// -----------------------------------------------------------------------------

void rgbtest(void)
{
    ESP_ERROR_CHECK(init_rgb_led());

    ESP_LOGI(TAG, "Common-cathode RGB LED test started");

    while (true) {
        ESP_LOGI(TAG, "Red");
        ESP_ERROR_CHECK(set_rgb(255, 0, 0));
        vTaskDelay(pdMS_TO_TICKS(1000));

        ESP_LOGI(TAG, "Green");
        ESP_ERROR_CHECK(set_rgb(0, 255, 0));
        vTaskDelay(pdMS_TO_TICKS(1000));

        ESP_LOGI(TAG, "Blue");
        ESP_ERROR_CHECK(set_rgb(0, 0, 255));
        vTaskDelay(pdMS_TO_TICKS(1000));

        ESP_LOGI(TAG, "Yellow");
        ESP_ERROR_CHECK(set_rgb(255, 255, 0));
        vTaskDelay(pdMS_TO_TICKS(1000));

        ESP_LOGI(TAG, "Cyan");
        ESP_ERROR_CHECK(set_rgb(0, 255, 255));
        vTaskDelay(pdMS_TO_TICKS(1000));

        ESP_LOGI(TAG, "Magenta");
        ESP_ERROR_CHECK(set_rgb(255, 0, 255));
        vTaskDelay(pdMS_TO_TICKS(1000));

        ESP_LOGI(TAG, "White");
        ESP_ERROR_CHECK(set_rgb(255, 255, 255));
        vTaskDelay(pdMS_TO_TICKS(1000));

        ESP_LOGI(TAG, "Dim white");
        ESP_ERROR_CHECK(set_rgb(32, 32, 32));
        vTaskDelay(pdMS_TO_TICKS(1000));

        ESP_LOGI(TAG, "Off");
        ESP_ERROR_CHECK(set_rgb(0, 0, 0));
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

// -----------------------------------------------------------------------------
// ESP-IDF entry point
// -----------------------------------------------------------------------------

void app_main(void)
{
    rgbtest();
}