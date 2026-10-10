cmake_minimum_required(VERSION 3.16)
project(space_guidance_plugin C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find Verilator if available
find_package(verilator QUIET)

# Output binary directory
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/bin)

# Plugin daemon stub / harness
add_executable(space_guidance_daemon src/space_guidance_daemon.cpp)
target_include_directories(space_guidance_daemon PRIVATE include)
