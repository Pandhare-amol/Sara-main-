# Sara OS

Sara OS is a bootable **x86_64 Debian 12 live/install image** that makes Sara the primary AI environment while retaining a normal XFCE desktop underneath. It does not replace the Linux kernel, Debian security model, or the existing Sara application architecture.

## What the image contains

- Hybrid ISO boot for UEFI and legacy BIOS PCs and virtual machines.
- Debian's live installer, with a live session named `sara`.
- XFCE, Chromium, NetworkManager, PipeWire, terminal, file manager, text editor, calculator, screenshot tool, and task manager.
- A bounded offline productivity set: LibreOffice Writer/Calc/Impress, VLC, Evince PDF viewer, Ristretto image viewer, File Roller, Geany, Simple Scan, Disks, Bluetooth Manager, and PulseAudio Volume Control.
- Practical command-line tools including FFmpeg, Git, rsync, zip/unzip, p7zip, htop, jq, tree, lsof, and DNS utilities.
- The production Sara frontend/backend and Linux-compatible local desktop agent.
- Automatic Sara launch as a maximized Chromium application; closing it reveals the regular desktop.
- Per-user state under `~/.local/share/sara` and logs under `~/.local/state/sara`.
- Gemini/provider credentials entered after boot. No API key, account, memory, or personal file is built into the ISO.
- Secret Service (`gnome-keyring`/`libsecret`) storage selected by the Sara OS session instead of the generic Linux plaintext fallback.

## Linux desktop integration

Sara indexes visible freedesktop `.desktop` entries from the user's XDG data directory, the system application directories, and standard Flatpak/Snap export directories. Voice tools and autonomous `app.list`, `app.launch`, and `app.close` actions therefore work with installed applications beyond the built-in aliases. Launching uses the desktop entry ID through `gtk-launch`; Sara does not shell-execute untrusted `Exec=` text from a desktop file. Hidden/`NoDisplay` entries are excluded and `TryExec` requirements are honored.

On Sara OS, master volume uses PipeWire's `wpctl`, laptop-panel brightness uses `brightnessctl` when hardware exposes a controllable backlight, screen lock/power requests use logind/systemd, auto-start uses a per-user XDG entry, and default-file opening uses `xdg-open`. Each integration checks command outcomes where the platform exposes them and reports missing hardware, services, or permissions instead of inventing success. Executable Linux files and scripts still require the existing explicit confirmation path.

## Build on Windows, macOS, or Linux

Install Docker Desktop (Windows/macOS) or Docker/Podman (Linux), with at least 12 GB free disk space and 8 GB RAM recommended. Then run:

```bash
npm ci
npm run os:validate
npm run os:build
```

The output is written to `out/sara-os/`:

- `SaraOS-<version>-amd64.iso`
- `SaraOS-<version>-amd64.iso.sha256`
- `build-info.json`

Alternative engine/output examples:

```bash
npm run os:build -- --engine podman --output out/podman-image
npm run os:build -- --no-cache
npm run os:build -- --dry-run
```

The builder refuses to overwrite an existing ISO unless `--force` is passed. The ISO build downloads Debian packages and container base images, so it requires internet access and can take substantial time. Debian `live-build` must mount `/proc` and `/dev/pts` inside its chroot, so the script runs the purpose-built, disposable builder container with `--privileged`. Inspect `os/Dockerfile` and `os/build-inside-container.sh` before building on a shared machine. Sara and the resulting desktop never run as privileged containers.

## Boot and install

1. Verify the ISO checksum using the adjacent `.sha256` file.
2. Test in a VM first (VirtualBox, VMware, Hyper-V, QEMU, or UTM).
3. For physical hardware, write the ISO to a USB drive with a trusted imaging tool. This overwrites the selected USB drive; the repository intentionally does not automate that destructive step.
4. Choose the live option to test without installing, or the graphical installer to install Debian/Sara OS.
5. Connect to a network and enter your own provider key in Sara's first-run screen.

The live session is ephemeral unless persistence is configured externally. An installed system stores each user's data in that user's home directory.

## Platform scope

“Cross-platform” means the ISO can be **built from Windows, macOS, or Linux** and booted on standard amd64 PCs/VMs. It does not make one kernel image natively boot every CPU architecture:

- Intel/AMD 64-bit: supported by this profile.
- Apple Silicon/ARM64: use x86_64 emulation for this image; a native ARM image requires a separately tested ARM kernel/firmware profile.
- Windows-only UI Automation, SMTC YouTube verification, DPAPI, and Microsoft Office COM remain Windows capabilities. Sara OS uses Linux/X11 controls for applications, windows, files, input, screenshots, network, and system metadata; it does not falsely report unavailable Windows integrations.

## Security boundaries

- Sara's web/backend and desktop-agent ports bind only to `127.0.0.1`.
- Chromium's sandbox remains enabled.
- The graphical session and backend run as the logged-in user, not root.
- Power, installation, deletion, sending, and other consequential actions retain the application's confirmation policy and the OS's PolicyKit/sudo boundaries.
- The ISO contains no credentials. `.env`, local data, personal characters, and licensed character assets are excluded from the container context.
- A Secret Service failure is surfaced rather than silently downgrading Sara OS credentials to plaintext storage.

## Verified image-build evidence

On 2026-10-26, the `sara-os-image` job ([job 121648160741](https://github.com/Pandhare-amol/Sara-main-/actions/runs/40344545344/job/121648160741)) for commit `97badeeca9911db1c733fe3f9023511a4f9dcc26` successfully:

1. passed the updated OS profile/application-tool contracts and Linux production build;
2. resolved and installed the expanded Debian desktop/tool package set;
3. ran Debian `live-build` in the disposable privileged builder;
4. produced `SaraOS-1.5.2-amd64.iso`;
5. verified its generated SHA-256 file; and
6. uploaded artifact `SaraOS-97badeeca9911db1c733fe3f9023511a4f9dcc26-amd64` (artifact ID `12662446439`, archive size 2,351,727,286 bytes, expiry `2026-11-02T15:12:40Z`).

This proves that the refreshed profile—including the new applications—resolves, builds into an ISO, passes checksum verification, and uploads successfully. It does **not** claim a manual VM or physical-hardware boot, installer walkthrough, persistence, microphone/GPU/Wi-Fi compatibility, or live Linux desktop-control acceptance.

## Validation limits

`npm run os:validate` checks profile structure, boot/installer configuration, loopback binding assumptions, credential exclusions, Linux dependency separation, artifact checksums, privileged-builder separation, and browser sandbox policy. Normal application tests and production builds still apply.

Producing and booting the final ISO requires Docker plus Debian package-network access. Automated profile/build tests are not equivalent to a manual boot test on every GPU, Wi-Fi adapter, microphone, firmware implementation, or VM platform.
