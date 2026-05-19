#pragma once

#if CHIP_DEVICE_CONFIG_ENABLE_THREAD

// Provides Matter/OpenThread launcher support for ESP32 platforms
#include <platform/ESP32/OpenthreadLauncher.h>

// Provides ESP-IDF OpenThread configuration types and constants
#include "esp_openthread_types.h"

// ESP32-H2 has native IEEE 802.15.4 radio support, so use native Thread radio mode
#define ESP_OPENTHREAD_DEFAULT_RADIO_CONFIG()                                           \
    {                                                                                   \
        .radio_mode = RADIO_MODE_NATIVE,                                                \
    }

// Sets the default OpenThread host configuration
#define ESP_OPENTHREAD_DEFAULT_HOST_CONFIG()                                            \
    {                                                                                   \
        .host_connection_mode = HOST_CONNECTION_MODE_NONE,                              \
    }

// Sets the default OpenThread port configuration
#define ESP_OPENTHREAD_DEFAULT_PORT_CONFIG()                                            \
    {                                                                                   \
        .storage_partition_name = "nvs",                                                \
        .netif_queue_size = 10,                                                         \
        .task_queue_size = 10,                                                          \
    }
#endif // CHIP_DEVICE_CONFIG_ENABLE_THREAD