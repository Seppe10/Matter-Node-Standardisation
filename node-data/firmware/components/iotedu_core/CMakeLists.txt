idf_component_register(SRCS "iotedu_core.cpp"
                       INCLUDE_DIRS "include"
                       PRIV_INCLUDE_DIRS "." "$ENV{ESP_MATTER_PATH}/examples/common/utils"
                       REQUIRES esp_matter app_reset espressif__esp_bsp_generic nvs_flash esp_hw_support)
