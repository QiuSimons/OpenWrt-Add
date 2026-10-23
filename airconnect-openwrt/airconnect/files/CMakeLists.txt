cmake_minimum_required(VERSION 3.10)
project(airconnect C CXX)

set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

add_definitions(-D_GNU_SOURCE -DNDEBUG -DUPNP_STATIC_LIB -DSSL_STATIC_LIB -DPB_FIELD_16BIT)

# Include directories
include_directories(
    common
    common/crosstools/src
    common/dmap-parser
    common/libmdns/mdnssd
    common/libmdns/mdnssvc
    common/libraop/src
    common/libpupnp/addons
    common/libcodecs/alac/codec
    common/libcodecs/addons
    aircast/nanopb
    airupnp/src
    aircast/src
)

# OpenSSL
find_package(OpenSSL REQUIRED)
include_directories(${OPENSSL_INCLUDE_DIR})

# libupnp (and ixml)
find_path(UPNP_INCLUDE_DIR upnp/upnp.h)
find_path(IXML_INCLUDE_DIR upnp/ixml.h)
find_library(UPNP_LIB upnp)
find_library(IXML_LIB ixml)
include_directories(${UPNP_INCLUDE_DIR} ${UPNP_INCLUDE_DIR}/upnp)

# flac
find_path(FLAC_INCLUDE_DIR FLAC/stream_encoder.h)
find_library(FLAC_LIB FLAC)
include_directories(${FLAC_INCLUDE_DIR})

# shine
find_path(SHINE_INCLUDE_DIR shine/layer3.h)
find_library(SHINE_LIB shine)
include_directories(${SHINE_INCLUDE_DIR} ${SHINE_INCLUDE_DIR}/shine)

# jansson
find_path(JANSSON_INCLUDE_DIR jansson.h)
find_library(JANSSON_LIB jansson)
include_directories(${JANSSON_INCLUDE_DIR})

# Common static library
set(COMMON_SRCS
    common/crosstools/src/cross_log.c
    common/crosstools/src/cross_net.c
    common/crosstools/src/cross_thread.c
    common/crosstools/src/cross_util.c
    common/crosstools/src/cross_ssl.c
    common/crosstools/src/platform.c
    common/libcodecs/addons/encoder.c
    common/dmap-parser/dmap_parser.c
    common/libmdns/mdnssd/mdnssd.c
    common/libmdns/mdnssvc/mdns.c
    common/libmdns/mdnssvc/mdnsd.c
    common/libpupnp/addons/ixmlextra.c
    common/libraop/src/raop_client.c
    common/libraop/src/rtsp_client.c
    common/libraop/src/raop_server.c
    common/libraop/src/raop_streamer.c
    common/libraop/src/aes.c
    common/libraop/src/aes_ctr.c
    common/libraop/src/alac.c
    common/libraop/src/bplist.cpp
    common/libraop/src/pairing.cpp
    common/libraop/src/password.c
    common/libcodecs/addons/alac_wrapper.cpp
    common/libcodecs/alac/codec/ALACBitUtilities.c
    common/libcodecs/alac/codec/ALACDecoder.cpp
    common/libcodecs/alac/codec/ALACEncoder.cpp
    common/libcodecs/alac/codec/EndianPortable.c
    common/libcodecs/alac/codec/ag_dec.c
    common/libcodecs/alac/codec/ag_enc.c
    common/libcodecs/alac/codec/dp_dec.c
    common/libcodecs/alac/codec/dp_enc.c
    common/libcodecs/alac/codec/matrix_dec.c
    common/libcodecs/alac/codec/matrix_enc.c
)

add_library(airconnect_common STATIC ${COMMON_SRCS})

# Target: airupnp
set(AIRUPNP_SRCS
    airupnp/src/airupnp.c
    airupnp/src/avt_util.c
    airupnp/src/mr_util.c
    airupnp/src/config_upnp.c
)

add_executable(airupnp ${AIRUPNP_SRCS})
target_link_libraries(airupnp PRIVATE
    airconnect_common
    ${UPNP_LIB}
    ${IXML_LIB}
    ${FLAC_LIB}
    ${SHINE_LIB}
    OpenSSL::SSL
    OpenSSL::Crypto
    pthread
    m
)

# Target: aircast
set(AIRCAST_SRCS
    aircast/src/aircast.c
    aircast/src/castcore.c
    aircast/src/cast_util.c
    aircast/src/cast_parse.c
    aircast/src/config_cast.c
    aircast/src/castmessage.pb.c
    aircast/nanopb/pb_common.c
    aircast/nanopb/pb_decode.c
    aircast/nanopb/pb_encode.c
)

add_executable(aircast ${AIRCAST_SRCS})
target_link_libraries(aircast PRIVATE
    airconnect_common
    ${JANSSON_LIB}
    ${UPNP_LIB}
    ${IXML_LIB}
    ${FLAC_LIB}
    ${SHINE_LIB}
    OpenSSL::SSL
    OpenSSL::Crypto
    pthread
    m
)

install(TARGETS airupnp aircast RUNTIME DESTINATION bin)
