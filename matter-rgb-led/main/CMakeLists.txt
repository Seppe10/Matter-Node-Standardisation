# -----------------------------------------------------------------------------
# CMake setup
# Configures the ESP-IDF project, ESP-Matter paths, required components, and compiler options needed to build the Matter-over-Thread application.
# -----------------------------------------------------------------------------

idf_component_register(
    SRCS
        "app_main.cpp"
    INCLUDE_DIRS
        "."
    PRIV_REQUIRES
        esp_matter
        chip
        nvs_flash
        esp_driver_ledc
        esp_driver_gpio
        openthread
)

target_compile_options(${COMPONENT_LIB} PRIVATE "-DCHIP_HAVE_CONFIG_H")