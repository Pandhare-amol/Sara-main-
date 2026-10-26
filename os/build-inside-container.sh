#!/bin/sh
# Runs only inside the purpose-built Sara OS builder container. live-build must
# mount /proc and /dev/pts in its chroot, so the outer launcher grants this
# disposable container --privileged rather than granting privileges to Sara.
set -eu

cd /work/profile
chmod 0755 auto/config config/includes.chroot/usr/local/bin/sara-session
chmod 0755 config/includes.chroot/etc/skel/Desktop/Sara.desktop
./auto/config
lb build

iso=$(find . -maxdepth 1 -type f -name '*.hybrid.iso' -print -quit)
test -n "$iso"
mkdir -p /out
output="SaraOS-${SARA_VERSION}-amd64.iso"
if [ -e "/out/$output" ] || [ -e "/out/$output.sha256" ]; then
  echo "Refusing to overwrite existing artifact /out/$output" >&2
  exit 2
fi
cp "$iso" "/out/$output"
cd /out
sha256sum "$output" > "$output.sha256"
printf '{\n  "name": "Sara OS",\n  "version": "%s",\n  "architecture": "amd64",\n  "base": "Debian 12 Bookworm",\n  "revision": "%s",\n  "artifact": "%s"\n}\n' \
  "$SARA_VERSION" "$SARA_REVISION" "$output" > build-info.json
chmod 0644 "$output" "$output.sha256" build-info.json
if [ "${SARA_OUTPUT_UID:-0}" != "0" ] || [ "${SARA_OUTPUT_GID:-0}" != "0" ]; then
  chown "${SARA_OUTPUT_UID:-0}:${SARA_OUTPUT_GID:-0}" "$output" "$output.sha256" build-info.json || true
fi
