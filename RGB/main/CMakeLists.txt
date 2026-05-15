idf_component_register(
    SRCS "rgbtest.c"
    INCLUDE_DIRS "."
    REQUIRES esp_driver_ledc esp_driver_gpio
)
