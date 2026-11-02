#pragma once

#include <stdint.h> 
#include "esp_err.h" 
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#pragma once

#include <stdint.h>     // Provides fixed-width integer types
#include "esp_err.h"    // Provides ESP-IDF error types

// Allows this header to be used safely from both C and C++ code
#ifdef __cplusplus
extern "C" {
#endif

// Stores a single reading from the DHT11 sensor
// The DHT11 provides temperature as a whole-number Celsius value and humidity as a whole-number percentage value
typedef struct {
    int8_t temperature;
    uint8_t humidity;
} dht11_reading_t;

#include "driver/gpio.h"

// Initialises the DHT11 on the default data GPIO, GPIO 4.
esp_err_t dht11_init(void);

// Initialises the DHT11 on a chosen data GPIO.
// GPIO8 is a strapping pin and GPIO9 is the factory-reset button, so both are rejected.
esp_err_t dht11_init_pin(gpio_num_t pin);

// Reads the current temperature and humidity from the DHT11 sensor
esp_err_t dht11_read(dht11_reading_t *out);

#ifdef __cplusplus
}
#endif