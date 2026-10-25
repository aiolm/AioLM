#!/bin/sh
# Runs inside the Alpine namespace that build.sh prepares: upstream's package
# list (scripts/docker/Dockerfile, alpine:3.21), checked against apk.lock, then
# upstream's own dependency and runtime build scripts, unchanged.
set -eu

apk update
apk add --no-cache --no-chown \
    bash alpine-sdk util-linux strace file autoconf automake libtool xz \
    eudev-dev gettext-dev linux-headers meson \
    zstd-dev zstd-static zlib-dev zlib-static clang musl-dev mimalloc-dev
# The Alpine 3.21 repository is a moving stable branch. Stop on any change to
# the resolved package set instead of building with an unreviewed toolchain.
apk info -v | sort > /tmp/apk-installed.txt
if ! diff -u /work/apk.lock /tmp/apk-installed.txt; then
    echo "the Alpine package set differs from apk.lock; review the change, rebuild and update apk.lock and RUNTIME_SHA256" >&2
    exit 1
fi

cd /work/type2-runtime
bash scripts/common/install-dependencies.sh
bash scripts/build-runtime.sh
mkdir -p /work/out
cp out/runtime-x86_64 out/runtime-x86_64.debug /work/out/
