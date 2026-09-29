{
  "targets": [
    {
      "target_name": "contention_addon",
      "sources": [ "src/addon.cpp" ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags_cc": [ "-std=c++17" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "libraries": [ "-lpthread" ],
      "defines": [ "NAPI_CPP_EXCEPTIONS", "_GNU_SOURCE" ]
    }
  ]
}
