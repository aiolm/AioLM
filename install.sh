#!/bin/bash
# Install AioLM on macOS from its GitHub release, verifying the DMG's SHA-256.
#
#   curl -fsSL https://raw.githubusercontent.com/aiolm/AioLM/main/install.sh | bash
#
# AIOLM_RELEASE     latest (default) or a release tag such as v0.3.0
# AIOLM_DRY_RUN     1 to stop after the download has been verified
# AIOLM_APPLICATIONS_DIR  install folder; default /Applications when writable,
#                   otherwise ~/Applications
# AIOLM_DMG and AIOLM_DMG_SHA256 install an already downloaded DMG instead.
#
# Files fetched with curl carry no quarantine attribute, so Gatekeeper does not
# assess this copy; the checksum is what verifies it. User data in ~/.aiolm is
# never touched.
set -euo pipefail

REPOSITORY="aiolm/AioLM"
APP_NAME="AioLM.app"
BUNDLE_ID="com.aiolm.desktop"
MINIMUM_MACOS="13.3"

fail() {
  echo "error: $*" >&2
  exit 1
}
info() {
  echo "==> $*"
}

[ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS; see the installation guide for other platforms"

version_at_least() {
  local IFS=.
  local -a have=($1) need=($2)
  local index
  for index in 0 1 2; do
    local a="${have[index]:-0}" b="${need[index]:-0}"
    if ((10#$a > 10#$b)); then return 0; fi
    if ((10#$a < 10#$b)); then return 1; fi
  done
  return 0
}
macos_version="$(sw_vers -productVersion)"
version_at_least "$macos_version" "$MINIMUM_MACOS" || fail "AioLM requires macOS $MINIMUM_MACOS or later (this Mac runs $macos_version)"

# A shell running under Rosetta still reports x86_64; install the native build.
architecture="$(uname -m)"
if [ "$architecture" = "x86_64" ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
  architecture="arm64"
fi
case "$architecture" in
  arm64) package_arch="aarch64" ;;
  x86_64) package_arch="x64" ;;
  *) fail "unsupported Mac architecture: $architecture" ;;
esac

release="${AIOLM_RELEASE:-latest}"
[[ "$release" == "latest" || "$release" =~ ^[A-Za-z0-9._-]+$ ]] || fail "invalid release value: $release"

workdir="$(mktemp -d "${TMPDIR:-/tmp}/aiolm-install.XXXXXX")"
mountpoint="$workdir/mount"
mounted=false
cleanup() {
  if [ "$mounted" = true ]; then
    /usr/bin/hdiutil detach -quiet "$mountpoint" >/dev/null 2>&1 || /usr/bin/hdiutil detach -force -quiet "$mountpoint" >/dev/null 2>&1 || true
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

trusted_url() {
  [[ "$1" =~ ^https://(github\.com|[A-Za-z0-9.-]+\.githubusercontent\.com)/ ]]
}
download() {
  /usr/bin/curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -H "User-Agent: aiolm-installer" "$@"
}
sha256() {
  /usr/bin/shasum -a 256 "$1" | awk '{print $1}'
}

# Print "<field>\t<value>" lines for the release tag, the DMG and checksums.txt.
release_fields() {
  /usr/bin/osascript -l JavaScript -e '
function run(argv) {
  const data = $.NSData.dataWithContentsOfFile(argv[0]);
  const release = JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);
  const tag = String(release.tag_name || "");
  const version = tag.replace(/^v/, "");
  const name = "AioLM_" + version + "_" + argv[1] + ".dmg";
  const assets = release.assets || [];
  const dmg = assets.find(asset => asset.name === name);
  const checksums = assets.find(asset => asset.name === "checksums.txt");
  const lines = ["tag\t" + tag, "version\t" + version, "name\t" + name];
  if (dmg) lines.push("url\t" + dmg.browser_download_url, "digest\t" + (dmg.digest || ""));
  if (checksums) lines.push("checksums\t" + checksums.browser_download_url);
  return lines.join("\n");
}' "$1" "$2"
}
field() {
  printf '%s\n' "$1" | awk -F '\t' -v key="$2" '$1 == key { sub(/^[^\t]*\t/, ""); print; exit }'
}

if [ -n "${AIOLM_DMG:-}" ]; then
  [ -f "$AIOLM_DMG" ] || fail "AIOLM_DMG does not name a file: $AIOLM_DMG"
  [[ "${AIOLM_DMG_SHA256:-}" =~ ^[0-9a-fA-F]{64}$ ]] || fail "AIOLM_DMG requires AIOLM_DMG_SHA256"
  dmg="$AIOLM_DMG"
  expected="$(printf '%s' "$AIOLM_DMG_SHA256" | tr '[:upper:]' '[:lower:]')"
  expected_version=""
else
  if [ "$release" = "latest" ]; then
    metadata_url="https://api.github.com/repos/$REPOSITORY/releases/latest"
  else
    metadata_url="https://api.github.com/repos/$REPOSITORY/releases/tags/$release"
  fi
  info "Resolving AioLM release ($release)"
  expected=""
  if download -H "Accept: application/vnd.github+json" -o "$workdir/release.json" "$metadata_url" 2>/dev/null; then
    fields="$(release_fields "$workdir/release.json" "$package_arch")"
    tag="$(field "$fields" tag)"
    name="$(field "$fields" name)"
    url="$(field "$fields" url)"
    [ -n "$url" ] || fail "release ${tag:-$release} does not include a macOS package for this Mac ($name)"
    expected="$(field "$fields" digest)"
    expected="${expected#sha256:}"
    checksums="$(field "$fields" checksums)"
  else
    # The anonymous API limit is shared by every user behind one address. The
    # release pages and download links are not subject to it.
    info "GitHub API unavailable; using the release download links and checksums.txt"
    if [ "$release" = "latest" ]; then
      tag="$(/usr/bin/curl -fsSI --proto '=https' --tlsv1.2 -o /dev/null -w '%{redirect_url}' "https://github.com/$REPOSITORY/releases/latest")" || fail "could not find the latest AioLM release"
      tag="${tag##*/}"
    else
      tag="$release"
    fi
    [[ "$tag" =~ ^[A-Za-z0-9._-]+$ ]] || fail "could not find the latest AioLM release"
    name="AioLM_${tag#v}_${package_arch}.dmg"
    url="https://github.com/$REPOSITORY/releases/download/$tag/$name"
    checksums="https://github.com/$REPOSITORY/releases/download/$tag/checksums.txt"
  fi
  trusted_url "$url" || fail "release asset URL is not a trusted HTTPS GitHub URL: $url"
  expected_version="${tag#v}"
  if ! [[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]]; then
    expected=""
    if [ -n "$checksums" ] && trusted_url "$checksums"; then
      download -o "$workdir/checksums.txt" "$checksums" || fail "could not download checksums.txt for $tag"
      # Releases up to v0.3.0 wrote checksums.txt with CRLF line endings.
      expected="$(awk -v file="$name" '{ sub(/\r$/, "") } $2 == file && $1 ~ /^[0-9a-fA-F]{64}$/ { print $1; exit }' "$workdir/checksums.txt")"
    fi
  fi
  [ -n "$expected" ] || fail "release $tag does not provide a SHA-256 for $name; it may not include a macOS package for this Mac"
  expected="$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')"
  dmg="$workdir/$name"
  info "Downloading $name"
  download -o "$dmg" "$url"
fi

actual="$(sha256 "$dmg")"
[ "$actual" = "$expected" ] || fail "SHA-256 mismatch: expected $expected, received $actual"
info "SHA-256 verified: $actual"
if [ "${AIOLM_DRY_RUN:-}" = "1" ] || [ "${AIOLM_DRY_RUN:-}" = "true" ]; then
  info "Dry run complete: $dmg"
  exit 0
fi

mkdir "$mountpoint"
/usr/bin/hdiutil attach -nobrowse -readonly -noautoopen -quiet -mountpoint "$mountpoint" "$dmg" || fail "could not open $dmg"
mounted=true
source_app="$mountpoint/$APP_NAME"
[ -d "$source_app" ] || fail "the disk image does not contain $APP_NAME"
plist_value() {
  /usr/bin/plutil -extract "$2" raw -o - "$1/Contents/Info.plist" 2>/dev/null || true
}
[ "$(plist_value "$source_app" CFBundleIdentifier)" = "$BUNDLE_ID" ] || fail "the disk image does not contain AioLM"
if [ -n "$expected_version" ] && [ "$(plist_value "$source_app" CFBundleShortVersionString)" != "$expected_version" ]; then
  fail "the disk image does not contain AioLM $expected_version"
fi
/usr/bin/codesign --verify --deep --strict "$source_app" || fail "the app's code signature is not intact"

if [ -n "${AIOLM_APPLICATIONS_DIR:-}" ]; then
  applications="$AIOLM_APPLICATIONS_DIR"
elif [ -w /Applications ]; then
  applications="/Applications"
else
  applications="$HOME/Applications"
fi
mkdir -p "$applications"
[ -w "$applications" ] || fail "cannot write to $applications"
target="$applications/$APP_NAME"
if [ -e "$target" ]; then
  [ "$(plist_value "$target" CFBundleIdentifier)" = "$BUNDLE_ID" ] || fail "$target exists and is not AioLM; move it before installing"
fi
# Replacing a running app's files is unsafe; any running AioLM window counts.
if /usr/bin/pgrep -f "/AioLM.app/Contents/MacOS/aiolm( |$)" >/dev/null; then
  fail "AioLM is running; quit it and run the installer again"
fi

# Copy beside the target first, so a failed copy leaves the installed app alone.
staging="$applications/.AioLM.app.install-$$"
backup="$applications/.AioLM.app.previous-$$"
rm -rf "$staging" "$backup"
/usr/bin/ditto "$source_app" "$staging" || { rm -rf "$staging"; fail "could not copy AioLM to $applications"; }
if [ -e "$target" ] && ! mv "$target" "$backup"; then
  rm -rf "$staging"
  fail "could not replace $target"
fi
if ! mv "$staging" "$target"; then
  [ -e "$backup" ] && mv "$backup" "$target"
  rm -rf "$staging"
  fail "could not place AioLM in $applications"
fi
rm -rf "$backup"

installed_version="$(plist_value "$target" CFBundleShortVersionString)"
info "Installed AioLM $installed_version in $applications"
if [ "$applications" != "/Applications" ] && [ -e "/Applications/$APP_NAME" ]; then
  echo "note: another copy remains in /Applications/$APP_NAME" >&2
fi
echo "Open AioLM from $applications. Your settings and models in ~/.aiolm are kept."
