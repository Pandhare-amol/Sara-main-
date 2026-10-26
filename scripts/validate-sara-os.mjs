#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "os/Dockerfile",
  "os/build-inside-container.sh",
  "os/README.md",
  "os/live/auto/config",
  "os/live/config/package-lists/sara.list.chroot",
  "os/live/config/includes.chroot/etc/os-release",
  "os/live/config/includes.chroot/etc/xdg/autostart/sara.desktop",
  "os/live/config/includes.chroot/usr/local/bin/sara-session",
  "desktop_agent/requirements-linux.txt",
  ".dockerignore",
];
const failures = [];
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) failures.push(`missing ${file}`);
}
if (!failures.length) {
  const config = read("os/live/auto/config");
  const packages = read("os/live/config/package-lists/sara.list.chroot");
  const launcher = read("os/live/config/includes.chroot/usr/local/bin/sara-session");
  const dockerfile = read("os/Dockerfile");
  const linuxRequirements = read("desktop_agent/requirements-linux.txt");
  const applicationTools = read("desktop_agent/tools_applications.py");
  const pcTools = read("desktop_agent/tools_pc.py");

  for (const token of ["--binary-images iso-hybrid", "--architectures amd64", "--debian-installer live", "username=sara"]) {
    if (!config.includes(token)) failures.push(`live-build config is missing ${token}`);
  }
  for (const pkg of ["linux-image-amd64", "live-boot", "grub-efi-amd64-bin", "chromium", "xfce4", "network-manager", "gnome-keyring", "libsecret-tools", "libreoffice-writer", "libreoffice-calc", "libreoffice-impress", "vlc", "evince", "geany", "pavucontrol", "brightnessctl", "libgtk-3-bin"]) {
    if (!new RegExp(`^${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(packages)) failures.push(`package list is missing ${pkg}`);
  }
  for (const token of ["http://127.0.0.1:3000", "MYRAA_DATA_DIR", "MYRAA_SECRET_BACKEND=libsecret", "NODE_ENV=production"]) {
    if (!launcher.includes(token)) failures.push(`session launcher is missing ${token}`);
  }
  if (/--no-sandbox\b/.test(launcher)) failures.push("Chromium sandbox must not be disabled");
  if (!dockerfile.includes("ENTRYPOINT [\"/usr/local/bin/build-sara-os-image\"]")) failures.push("Dockerfile must invoke the live-build entrypoint");
  const innerBuilder = read("os/build-inside-container.sh");
  if (!innerBuilder.includes("sha256sum")) failures.push("container build entrypoint must emit an ISO SHA-256 file");
  const outerBuilder = read("scripts/build-sara-os.mjs");
  if (!outerBuilder.includes('"--privileged"')) failures.push("outer builder must grant the disposable live-build container mount privileges");
  for (const forbidden of ["pywin32", "pywinauto", "pycaw", "winrt-"]) {
    if (new RegExp(`^${forbidden}`, "m").test(linuxRequirements)) failures.push(`Linux requirements include Windows-only dependency ${forbidden}`);
  }
  for (const token of ["_linux_desktop_candidates", 'register("listApplications")', "gtk-launch"]) {
    if (!applicationTools.includes(token)) failures.push(`Linux application discovery is missing ${token}`);
  }
  for (const token of ["wpctl", "brightnessctl", 'systemctl", "suspend"']) {
    if (!pcTools.includes(token)) failures.push(`Linux desktop controls are missing ${token}`);
  }

  const osTree = walk(path.join(root, "os"))
    .map((file) => read(path.relative(root, file)))
    .join("\n");
  for (const pattern of [/AIza[0-9A-Za-z_-]{20,}/, /sk-[0-9A-Za-z_-]{20,}/, /GEMINI_API_KEY\s*=\s*[^"'\s$][^\s]*/]) {
    if (pattern.test(osTree)) failures.push(`OS profile appears to contain a credential matching ${pattern}`);
  }
}

if (failures.length) {
  console.error("Sara OS profile validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Sara OS profile validation passed (${required.length} required components).`);

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}
