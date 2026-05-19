#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "rom/ets_sys.h"

#define DHT11_PIN          GPIO_NUM_4
#define DHT11_TIMEOUT_US   1000

static const char *TAG = "DHT11";

typedef struct {
    int8_t  temperature;   // °C, integer
    uint8_t humidity;      // %RH, integer
} dht11_reading_t;

// Wait for the GPIO line to reach `level`, return microseconds elapsed.
// Returns -1 on timeout.
static int wait_for_level(int level, int timeout_us)
{
    int64_t start = esp_timer_get_time();
    while (gpio_get_level(DHT11_PIN) != level) {
        if ((esp_timer_get_time() - start) > timeout_us) {
            return -1;
        }
    }
    return (int)(esp_timer_get_time() - start);
}

esp_err_t dht11_read(dht11_reading_t *out)
{
    uint8_t data[5] = {0};

    // ---- Step 1: MCU start signal ----
    gpio_set_direction(DHT11_PIN, GPIO_MODE_OUTPUT);
    gpio_set_level(DHT11_PIN, 0);
    ets_delay_us(20000);                  // hold low ≥18ms
    gpio_set_level(DHT11_PIN, 1);
    ets_delay_us(30);                     // release, brief high
    gpio_set_direction(DHT11_PIN, GPIO_MODE_INPUT);

    // ---- Step 2: sensor handshake (80µs low, 80µs high) ----
    if (wait_for_level(0, DHT11_TIMEOUT_US) < 0) {
        ESP_LOGW(TAG, "no response (low handshake)");
        return ESP_ERR_TIMEOUT;
    }
    if (wait_for_level(1, DHT11_TIMEOUT_US) < 0) {
        ESP_LOGW(TAG, "no response (high handshake)");
        return ESP_ERR_TIMEOUT;
    }
    if (wait_for_level(0, DHT11_TIMEOUT_US) < 0) {
        ESP_LOGW(TAG, "no response (post-handshake low)");
        return ESP_ERR_TIMEOUT;
    }

    // ---- Step 3: read 40 bits ----
    // Each bit: 50µs low, then ~26µs high (=0) or ~70µs high (=1)
    for (int i = 0; i < 40; i++) {
        // Wait through the 50µs low
        if (wait_for_level(1, DHT11_TIMEOUT_US) < 0) {
            ESP_LOGW(TAG, "timeout waiting for bit %d high", i);
            return ESP_ERR_TIMEOUT;
        }
        // Measure the high pulse
        int high_us = wait_for_level(0, DHT11_TIMEOUT_US);
        if (high_us < 0) {
            ESP_LOGW(TAG, "timeout measuring bit %d", i);
            return ESP_ERR_TIMEOUT;
        }
        // >40µs ≈ 1, otherwise 0
        if (high_us > 40) {
            data[i / 8] |= (1 << (7 - (i % 8)));
        }
    }

    // ---- Step 4: checksum ----
    uint8_t sum = data[0] + data[1] + data[2] + data[3];
    if (sum != data[4]) {
        ESP_LOGW(TAG, "checksum fail: %02x %02x %02x %02x sum=%02x got=%02x",
                 data[0], data[1], data[2], data[3], sum, data[4]);
        return ESP_ERR_INVALID_CRC;
    }

    out->humidity    = data[0];
    out->temperature = (int8_t)data[2];
    return ESP_OK;
}

void app_main(void)
{
    // Configure GPIO once
    gpio_config_t io = {
        .pin_bit_mask = (1ULL << DHT11_PIN),
        .mode         = GPIO_MODE_INPUT,
        .pull_up_en   = GPIO_PULLUP_DISABLE,   // module has its own
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    gpio_config(&io);

    // First read tends to fail right after power-up — give sensor 2s to settle
    vTaskDelay(pdMS_TO_TICKS(2000));

    while (1) {
        dht11_reading_t r;
        esp_err_t err = dht11_read(&r);
        if (err == ESP_OK) {
            ESP_LOGI(TAG, "Temperature: %d°C   Humidity: %u%%RH",
                     r.temperature, r.humidity);
        } else {
            ESP_LOGE(TAG, "read failed: %s", esp_err_to_name(err));
        }
        // DHT11 needs ≥1s between samples; 2s is comfortable
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}