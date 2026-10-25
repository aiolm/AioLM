#!/bin/sh
# Build the AppImage type2 runtime pinned in pins.conf, with patches/, without
# root, Docker or sudo.
#
# This is upstream's chroot build (scripts/chroot/chroot_build.sh at the pinned
# commit): the same Alpine release and signing key, the package list of
# scripts/docker/Dockerfile, and upstream's unchanged install-dependencies.sh
# and build-runtime.sh. Only the isolation differs: an unprivileged bubblewrap
# user namespace replaces `sudo chroot`.
#
# Usage: build.sh <new-work-dir>
# Result: <work-dir>/out/runtime-x86_64, checked against RUNTIME_SHA256.
set -eu
export LC_ALL=C

here=$(dirname "$(readlink -f "$0")")
. "$here/pins.conf"
PATCHES="patches/0001-rm_recursive-pass-positive-nftw-fd_limit.patch
patches/0002-extract-and-run-use-a-per-instance-directory.patch"
ALPINE_TARBALL=alpine-minirootfs-${ALPINE_RELEASE}-${ALPINE_ARCH}.tar.gz
ALPINE_URL=https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_RELEASE%.*}/releases/${ALPINE_ARCH}/${ALPINE_TARBALL}

work=$1
[ ! -e "$work" ] || { echo "work directory must not exist yet: $work" >&2; exit 2; }
mkdir -p "$work"
work=$(readlink -f "$work")
cd "$work"

# Upstream source at the pinned commit only.
git init -q source
git -C source fetch -q --depth 1 "$TYPE2_RUNTIME_REPOSITORY" "$TYPE2_RUNTIME_COMMIT"
[ "$(git -C source rev-parse FETCH_HEAD)" = "$TYPE2_RUNTIME_COMMIT" ]

# Alpine minirootfs: pinned hash and a signature by the pinned key.
mkdir -m 700 gnupg
git -C source show "$TYPE2_RUNTIME_COMMIT:scripts/chroot/ncopa.asc" > ncopa.asc
gpg --homedir gnupg --batch --quiet --import ncopa.asc
curl -fsSLo "$ALPINE_TARBALL" "$ALPINE_URL"
curl -fsSLo "$ALPINE_TARBALL.asc" "$ALPINE_URL.asc"
echo "$ALPINE_MINIROOTFS_SHA256  $ALPINE_TARBALL" | sha256sum -c -
gpg --homedir gnupg --batch --status-fd 1 --verify "$ALPINE_TARBALL.asc" "$ALPINE_TARBALL" \
    | grep -q "^\[GNUPG:\] VALIDSIG $ALPINE_KEY_FINGERPRINT "

mkdir rootfs
tar -xzf "$ALPINE_TARBALL" -C rootfs
mkdir -p rootfs/work/type2-runtime
git -C source archive "$TYPE2_RUNTIME_COMMIT" | tar -x -C rootfs/work/type2-runtime
for patch in $PATCHES; do
    patch -d rootfs/work/type2-runtime -p1 --no-backup-if-mismatch < "$here/$patch"
done
printf '%s' "$RUNTIME_VERSION" > rootfs/work/type2-runtime/src/runtime/version
cp "$here/inside-build.sh" "$here/apk.lock" rootfs/work/
cp /etc/resolv.conf rootfs/etc/resolv.conf

# Root inside the namespace is the calling user and nothing can be chowned to
# other IDs: apk runs with --no-chown and GNU tar with --no-same-owner. The
# host's /dev/fuse node is bound in so libfuse's install helper does not try
# mknod; the build links libfuse3.a and never opens the device. The host
# network is shared for apk and upstream's pinned source downloads.
bwrap --clearenv --unshare-user --uid 0 --gid 0 --unshare-pid --unshare-ipc --unshare-uts --share-net \
      --bind rootfs / --dev /dev --dev-bind /dev/fuse /dev/fuse --proc /proc --tmpfs /tmp \
      --setenv PATH /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      --setenv HOME /root --setenv LC_ALL C --setenv TAR_OPTIONS --no-same-owner \
      --setenv SOURCE_DATE_EPOCH "$(git -C source log -1 --format=%ct "$TYPE2_RUNTIME_COMMIT")" \
      --chdir /work /bin/sh -eu /work/inside-build.sh

mkdir out
cp rootfs/work/out/runtime-x86_64 rootfs/work/out/runtime-x86_64.debug out/
(cd "$here" && sha256sum pins.conf apk.lock inside-build.sh build.sh $PATCHES) > out/inputs.sha256
echo "$RUNTIME_SHA256  out/runtime-x86_64" | sha256sum -c - || {
    echo "the built runtime differs from RUNTIME_SHA256 in pins.conf; review the build before updating the pin" >&2
    exit 1
}
