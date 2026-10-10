cmake_minimum_required(VERSION 3.16)
project(space_guidance_plugin C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/bin)

include_directories(include)

add_executable(space_guidance_daemon
    src/space_guidance_daemon.cpp
    src/space_physics.cpp
)
target_link_libraries(space_guidance_daemon pthread)
