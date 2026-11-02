#pragma once

#include <esp_err.h>
#include <esp_matter.h>

// Prepares NVS, the GPIO9 factory-reset button, and the Matter node.
// esp_matter::start is intentionally separate so a driver can register endpoints first.
esp_err_t iotedu_core_prepare(esp_matter::node_t **node);

// Applies the OpenThread platform config when Thread is enabled, then starts Matter.
esp_err_t iotedu_core_start(void);
