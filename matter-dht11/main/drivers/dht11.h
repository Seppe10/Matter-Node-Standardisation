#pragma once

#include <stdint.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#pragma once

#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    int8_t temperature;
    uint8_t humidity;
} dht11_reading_t;

esp_err_t dht11_init(void);
esp_err_t dht11_read(dht11_reading_t *out);

#ifdef __cplusplus
}
#endif