// -----------------------------------------------------------------------------
// DHT11 Temperature and Humidity Sensor Driver
// -----------------------------------------------------------------------------
// This file contains a basic DHT11 driver for ESP-IDF. It communicates with the DHT11 sensor using a single GPIO pin and reads temperature and humidity data using the DHT11's timing-based one-wire style protocol
// Main functions of this code:
// 1. Configure the GPIO pin used by the DHT11 sensor
// 2. Send the start signal required by the DHT11
// 3. Wait for the DHT11 response handshake
// 4. Read the 40-bit data packet sent by the sensor
// 5. Verify the checksum
// 6. Return humidity and temperature values to the calling code
// -----------------------------------------------------------------------------

#include "dht11.h"

#include "driver/gpio.h"    // ESP-IDF GPIO driver
#include "esp_log.h"    // ESP-IDF logging functions
#include "esp_timer.h"  // Used for microsecond timing measurements
#include "rom/ets_sys.h"    // Provides ets_delay_us() for short blocking delays

// -----------------------------------------------------------------------------
// DHT11 hardware configuration
// -----------------------------------------------------------------------------
// DHT11_PIN defines the GPIO connected to the DHT11 data pin
// -----------------------------------------------------------------------------

#define DHT11_PIN          GPIO_NUM_4

// Maximum time to wait for each expected signal transition from the DHT11
#define DHT11_TIMEOUT_US   1000

// Log tag used to identify DHT11 messages in the serial monitor
static const char *TAG = "DHT11";

// -----------------------------------------------------------------------------
// Timing helper
// -----------------------------------------------------------------------------
// Waits until the DHT11 data pin reaches the requested logic level
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// DHT11 initialisation
// -----------------------------------------------------------------------------
// Configures the DHT11 GPIO as an input when the driver starts
// The pin direction is later changed during dht11_read() because the DHT11 protocol requires the ESP32 to first drive the line low, then release it
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// DHT11 read function
// -----------------------------------------------------------------------------
// Reads one temperature/humidity sample from the DHT11
// The DHT11 sends 5 bytes of data:
// - Byte 0: humidity integer part
// - Byte 1: humidity decimal part, usually 0 for DHT11
// - Byte 2: temperature integer part
// - Byte 3: temperature decimal part, usually 0 for DHT11
// - Byte 4: checksum
// -----------------------------------------------------------------------------
esp_err_t dht11_read(dht11_reading_t *out)
{
    // Check that the caller provided a valid output structure
    if (out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    // The DHT11 sends 40 bits total, stored here as 5 bytes
    uint8_t data[5] = {0};

    // -------------------------------------------------------------------------
    // Send start signal to DHT11
    // -------------------------------------------------------------------------

    // The ESP32 starts communication by pulling the data line LOW. This tells the DHT11 to prepare a reading
    gpio_set_direction(DHT11_PIN, GPIO_MODE_OUTPUT);
    gpio_set_level(DHT11_PIN, 0);
    ets_delay_us(20000);

    // Release the line by setting it HIGH briefly, then switch to input so the DHT11 can control the data line
    gpio_set_level(DHT11_PIN, 1);
    ets_delay_us(30);

    gpio_set_direction(DHT11_PIN, GPIO_MODE_INPUT);

    // -------------------------------------------------------------------------
    // Read DHT11 response handshake
    // -------------------------------------------------------------------------
    // After the start signal, the DHT11 should respond with a LOW/HIGH/LOW sequence. If any part of this sequence is missing, the sensor is probably not connected correctly, not powered, missing a pull-up resistor, or using the wrong GPIO
    // -------------------------------------------------------------------------
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

    // -------------------------------------------------------------------------
    // Read 40 data bits
    // -------------------------------------------------------------------------
    // Each DHT11 bit starts with the line going HIGH. The length of the HIGH pulse determines whether the bit is a 0 or a 1:
    // - Short HIGH pulse = 0
    // - Longer HIGH pulse = 1
    //
    // This driver uses 40 microseconds as the threshold. If the HIGH pulse is longer than 40, the bit is treated as 1. Otherwise, it remains 0
    // -------------------------------------------------------------------------
    for (int i = 0; i < 40; i++) {
        // Wait for the start of the HIGH pulse for this bit
        if (wait_for_level(1, DHT11_TIMEOUT_US) < 0) {
            ESP_LOGW(TAG, "Timeout waiting for bit %d high", i);
            return ESP_ERR_TIMEOUT;
        }

        // Measure how long the line stays HIGH before returning LOW
        int high_us = wait_for_level(0, DHT11_TIMEOUT_US);

        if (high_us < 0) {
            ESP_LOGW(TAG, "Timeout measuring bit %d", i);
            return ESP_ERR_TIMEOUT;
        }

        if (high_us > 40) {
            data[i / 8] |= (1 << (7 - (i % 8)));
        }
    }

    // -------------------------------------------------------------------------
    // Verify checksum
    // -------------------------------------------------------------------------
    // The fifth byte sent by the DHT11 is used to confirm the data is valid
    // If the checksum does not match, the reading is rejected
    // -------------------------------------------------------------------------
    uint8_t checksum = data[0] + data[1] + data[2] + data[3];

    if (checksum != data[4]) {
        ESP_LOGW(TAG,
                 "Checksum failed: %02x %02x %02x %02x checksum=%02x expected=%02x",
                 data[0], data[1], data[2], data[3], checksum, data[4]);
        return ESP_ERR_INVALID_CRC;
    }

    // -------------------------------------------------------------------------
    // Store final reading
    // -------------------------------------------------------------------------
    // For a DHT11, the integer humidity is in byte 0 and the integer temperature is in byte 2. Decimal bytes are ignored here because basic DHT11 sensors generally report whole-number values
    // -------------------------------------------------------------------------
    out->humidity = data[0];
    out->temperature = (int8_t)data[2];

    return ESP_OK;
}