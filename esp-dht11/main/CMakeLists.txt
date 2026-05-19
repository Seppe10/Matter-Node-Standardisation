idf_component_register(SRCS "dht11_main.c"
                       INCLUDE_DIRS "."
                       PRIV_REQUIRES esp_driver_gpio esp_timer log freertos)