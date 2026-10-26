# syntax=docker/dockerfile:1.7
# Sara OS uses a Debian builder container so the same command works from Docker
# Desktop on Windows/macOS and Docker/Podman on Linux. The image is later run as
# a disposable privileged container because live-build must mount /proc/devpts.

ARG NODE_IMAGE=node:20-bookworm-slim
ARG PYTHON_IMAGE=python:3.11-slim-bookworm
ARG DEBIAN_IMAGE=debian:bookworm-slim

FROM ${NODE_IMAGE} AS app-builder
WORKDIR /src
ENV npm_config_audit=false npm_config_fund=false VITE_MYRAA_PUBLIC=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build \
    && npm prune --omit=dev \
    && mkdir -p /bundle/app/assets /bundle/runtime/bin \
    && cp -a dist node_modules package.json /bundle/app/ \
    && cp -a desktop_agent /bundle/app/desktop_agent \
    && if [ -d assets ]; then cp -a assets/. /bundle/app/assets/; fi \
    && cp /usr/local/bin/node /bundle/runtime/bin/node

FROM ${PYTHON_IMAGE} AS agent-builder
WORKDIR /agent
COPY desktop_agent/requirements-linux.txt ./requirements-linux.txt
RUN python -m pip install --no-cache-dir --disable-pip-version-check \
      --target /opt/sara/python-packages \
      -r requirements-linux.txt

FROM ${DEBIAN_IMAGE} AS iso-builder
ARG SARA_VERSION=dev
ARG SARA_REVISION=unknown
ARG SOURCE_DATE_EPOCH=0
ENV DEBIAN_FRONTEND=noninteractive \
    SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
    SARA_VERSION=${SARA_VERSION} \
    SARA_REVISION=${SARA_REVISION}
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      live-build debootstrap xorriso squashfs-tools \
      isolinux syslinux-common syslinux-efi \
      grub-pc-bin grub-efi-amd64-bin mtools dosfstools \
      cpio gzip bzip2 xz-utils zstd wget file uuid-runtime parted fdisk \
      ca-certificates curl rsync \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work/profile
COPY os/live/ ./
COPY --from=app-builder /bundle/app/ ./config/includes.chroot/opt/sara/app/
COPY --from=app-builder /bundle/runtime/ ./config/includes.chroot/opt/sara/runtime/
COPY --from=agent-builder /opt/sara/python-packages/ ./config/includes.chroot/opt/sara/python-packages/
COPY build/icon.png ./config/includes.chroot/usr/share/icons/hicolor/256x256/apps/sara.png
COPY os/build-inside-container.sh /usr/local/bin/build-sara-os-image
RUN chmod 0755 /usr/local/bin/build-sara-os-image \
    auto/config config/includes.chroot/usr/local/bin/sara-session \
    config/includes.chroot/etc/skel/Desktop/Sara.desktop

ENTRYPOINT ["/usr/local/bin/build-sara-os-image"]
