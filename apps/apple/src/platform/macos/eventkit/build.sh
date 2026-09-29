#!/bin/sh
# Builds the universal (arm64 + x86_64) eventkit helper at the given path.
# Info.plist is embedded so macOS can show the access prompt for the binary.
set -eu
here=$(dirname "$0")
out=$1
mkdir -p "$(dirname "$out")"
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos13" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$here/Info.plist" \
    "$here"/*.swift -o "$out-$arch"
done
lipo -create "$out-arm64" "$out-x86_64" -output "$out"
rm "$out-arm64" "$out-x86_64"
# The linker's ad-hoc signature names the binary after its per-arch file and
# leaves Info.plist unbound; without a bound identity macOS drops the access
# request instead of prompting.
codesign --force --sign - --identifier com.context-compiler.eventkit "$out"
