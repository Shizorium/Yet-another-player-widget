# Included components

The executable extracts unmodified copies of its tools to a per-user runtime directory.
No system installation or external package manager is used at runtime.

- Node.js 24.22.1 Windows x64: https://nodejs.org/dist/v24.22.1/win-x64/node.exe
  - SHA-256: d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5
  - Source and bundled third-party notices: https://github.com/nodejs/node/tree/v24.22.1
  - License: Node.js-LICENSE.txt
- yt-dlp 2026.10.26: https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26
  - Binary: https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe
  - SHA-256: f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d
  - Source: https://github.com/yt-dlp/yt-dlp/tree/2026.10.26
  - Licenses and notices: yt-dlp-LICENSE.txt, yt-dlp-THIRD-PARTY.txt
- FFmpeg and ffprobe: Gyan static essentials Windows x64 build.
  - Distribution: https://www.gyan.dev/ffmpeg/builds/
  - Exact source revision and build configuration: FFmpeg-README.txt
  - License: FFmpeg-LICENSE.txt (GPLv3).
  - Upstream source: https://github.com/FFmpeg/FFmpeg
  - Distributor's build recipes: https://github.com/GyanD/codexffmpeg

The SEA launcher is made from Node.js with its original signature removed because
it is a new executable. The extracted node.exe remains unmodified. postject is a
build-only dependency and is not required on the user's computer.

Exact per-file hashes are recorded in ../bundle-info.json and inside Helper.exe.
