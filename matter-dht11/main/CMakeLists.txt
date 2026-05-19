# -----------------------------------------------------------------------------
# CMake setup
# Configures the ESP-IDF project, ESP-Matter paths, required components, and compiler options needed to build the Matter-over-Thread application.
# -----------------------------------------------------------------------------

idf_component_register(SRC_DIRS          "." "drivers"
                       PRIV_INCLUDE_DIRS "." "drivers" "${ESP_MATTER_PATH}/examples/common/utils")

target_compile_options(${COMPONENT_LIB} PRIVATE "-DCHIP_HAVE_CONFIG_H")
