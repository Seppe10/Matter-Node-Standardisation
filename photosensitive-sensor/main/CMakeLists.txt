idf_component_register(SRCS "photosentitive.c"
                       INCLUDE_DIRS "."
                       PRIV_REQUIRES esp_driver_gpio esp_timer log freertos)