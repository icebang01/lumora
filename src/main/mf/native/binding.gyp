{
  "targets": [
    {
      "target_name": "mf_backend",
      "sources": [ "mf_backend.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [ "NAPI_CPP_EXCEPTIONS" ],
      "conditions": [
        [ "OS=='win'", {
          "libraries": [
            "-lmfplat.lib",
            "-lmfreadwrite.lib",
            "-lmfuuid.lib",
            "-lmf.lib",
            "-lole32.lib",
            "-loleaut32.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "RuntimeLibrary": "MultiThreadedDLL",
              "AdditionalOptions": ["/utf-8"]
            }
          }
        } ]
      ],
      "cflags_cc": [ "-fexceptions" ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++"
      }
    }
  ]
}
