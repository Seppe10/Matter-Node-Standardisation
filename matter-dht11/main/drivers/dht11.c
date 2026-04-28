#include "dht11.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "rom/ets_sys.h"

#define DHT11_PIN          GPIO_NUM_4
#define DHT11_TIMEOUT_US   1000

static const char *TAG = "DHT11";

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

esp_err_t dht11_init(void)
{
    gpio_config_t io = {
        .pin_bit_mask = (1ULL << DHT11_PIN),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };

    return gpio_config(&io);
}

esp_err_t dht11_read(dht11_reading_t *out)
{
    if (out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t data[5] = {0};

    gpio_set_direction(DHT11_PIN, GPIO_MODE_OUTPUT);
    gpio_set_level(DHT11_PIN, 0);
    ets_delay_us(20000);

    gpio_set_level(DHT11_PIN, 1);
    ets_delay_us(30);

    gpio_set_direction(DHT11_PIN, GPIO_MODE_INPUT);

    if (wait_for_level(0, DHT11_TIMEOUT_US) < 0) {
        ESP_LOGW(TAG, "No response: low handshake");
        return ESP_ERR_TIMEOUT;
    }

    if (wait_for_level(1, DHT11_TIMEOUT_US) < 0) {
        ESP_LOGW(TAG, "No response: high handshake");
        return ESP_ERR_TIMEOUT;
    }

    if (wait_for_level(0, DHT11_TIMEOUT_US) < 0) {
        ESP_LOGW(TAG, "No response: post-handshake low");
        return ESP_ERR_TIMEOUT;
    }

    for (int i = 0; i < 40; i++) {
        if (wait_for_level(1, DHT11_TIMEOUT_US) < 0) {
            ESP_LOGW(TAG, "Timeout waiting for bit %d high", i);
            return ESP_ERR_TIMEOUT;
        }

        int high_us = wait_for_level(0, DHT11_TIMEOUT_US);

        if (high_us < 0) {
            ESP_LOGW(TAG, "Timeout measuring bit %d", i);
            return ESP_ERR_TIMEOUT;
        }

        if (high_us > 40) {
            data[i / 8] |= (1 << (7 - (i % 8)));
        }
    }

    uint8_t checksum = data[0] + data[1] + data[2] + data[3];

    if (checksum != data[4]) {
        ESP_LOGW(TAG,
                 "Checksum failed: %02x %02x %02x %02x checksum=%02x expected=%02x",
                 data[0], data[1], data[2], data[3], checksum, data[4]);
        return ESP_ERR_INVALID_CRC;
    }

    out->humidity = data[0];
    out->temperature = (int8_t)data[2];

    return ESP_OK;
}