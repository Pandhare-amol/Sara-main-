import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

test("Sara OS profile defines a hybrid live/install image and cross-platform container export", () => {
  const config = read("os/live/auto/config");
  const dockerfile = read("os/Dockerfile");
  assert.match(config, /--architectures amd64/);
  assert.match(config, /--binary-images iso-hybrid/);
  assert.match(config, /--debian-installer live/);
  assert.match(config, /username=sara/);
  assert.match(dockerfile, /FROM scratch AS artifact/);
  assert.match(dockerfile, /sha256sum/);
  assert.match(dockerfile, /SaraOS-\$\{SARA_VERSION\}-amd64\.iso/);
});

test("Sara OS shell is local, non-root, sandboxed, and uses Secret Service", () => {
  const launcher = read("os/live/config/includes.chroot/usr/local/bin/sara-session");
  assert.match(launcher, /http:\/\/127\.0\.0\.1:3000/);
  assert.match(launcher, /MYRAA_DATA_DIR=/);
  assert.match(launcher, /MYRAA_SECRET_BACKEND=libsecret/);
  assert.match(launcher, /NODE_ENV=production/);
  assert.doesNotMatch(launcher, /--no-sandbox\b/);
  assert.doesNotMatch(launcher, /sudo|\bsu\s/);
});

test("Sara OS separates Linux dependencies from Windows automation packages", () => {
  const requirements = read("desktop_agent/requirements-linux.txt");
  for (const required of ["fastapi", "uvicorn", "pyautogui", "psutil", "Pillow", "mss", "Send2Trash"]) {
    assert.match(requirements, new RegExp(`^${required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\[[^\\]]+\\])?==`, "m"));
  }
  for (const forbidden of ["pywin32", "pywinauto", "pycaw", "winrt-"]) {
    assert.doesNotMatch(requirements, new RegExp(`^${forbidden}`, "m"));
  }
});

test("Sara OS profile validator and dry-run builder pass without Docker", () => {
  const validation = execFileSync(process.execPath, ["scripts/validate-sara-os.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(validation, /validation passed/);

  const dryRun = execFileSync(process.execPath, ["scripts/build-sara-os.mjs", "--dry-run", "--output", "out/test-os"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(dryRun, /--platform/);
  assert.match(dryRun, /linux\/amd64/);
  assert.match(dryRun, /os\/Dockerfile/);
});

test("Sara OS profile contains no embedded provider key", () => {
  const files = [
    "os/Dockerfile",
    "os/live/auto/config",
    "os/live/config/includes.chroot/usr/local/bin/sara-session",
    "os/live/config/package-lists/sara.list.chroot",
  ];
  const profile = files.map(read).join("\n");
  assert.doesNotMatch(profile, /AIza[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(profile, /sk-[0-9A-Za-z_-]{20,}/);
});
