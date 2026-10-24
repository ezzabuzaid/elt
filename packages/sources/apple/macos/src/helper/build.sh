#!/bin/sh
set -eu
here=$(dirname "$0")
out=$1
mkdir -p "$(dirname "$out")"
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos27" "$here"/*.swift -o "$out-$arch"
done
lipo -create "$out-arm64" "$out-x86_64" -output "$out"
rm "$out-arm64" "$out-x86_64"
codesign --force --sign - "$out"
