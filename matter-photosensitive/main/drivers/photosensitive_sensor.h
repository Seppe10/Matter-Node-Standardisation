#pragma once

// Provides fixed-width integer types, such as uint16_t
#include <stdint.h>

// Provides ESP-IDF error types, such as esp_err_t
#include "esp_err.h"

// Initialises the photosensitive sensor driver
// The endpoint_id links the sensor readings to the correct Matter endpoint, allowing the device to report light-level data through that endpoint
esp_err_t photosensitive_sensor_init(uint16_t endpoint_id);
