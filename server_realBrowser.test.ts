import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const serverSource = readFileSync(path.join(root, "server.ts"), "utf8");
const appSource = readFileSync(path.join(root, "src", "App.tsx"), "utf8");
const electronSource = readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
const agentMainSource = readFileSync(path.join(root, "desktop_agent", "main.py"), "utf8");
const registrySource = readFileSync(path.join(root, "desktop_agent", "registry.py"), "utf8");

test("only the Windows default-browser tool family is exposed", () => {
  for (const removedTool of [
    "browserOpen",
    "browserSearch",
    "browserClick",
    "browserMediaControl",
    "browserTabAction",
    "desktopBrowser",
  ]) {
    assert.equal(serverSource.includes(removedTool), false, `${removedTool} remains in server.ts`);
    assert.equal(registrySource.includes(removedTool), false, `${removedTool} remains in registry.py`);
  }

  for (const realPcTool of ["openWebsite", "searchYouTube", "viewScreen", "clickText", "typeText"]) {
    assert.equal(serverSource.includes(`name: "${realPcTool}"`), true, `${realPcTool} is missing`);
  }
});

test("the renderer and backend have no embedded browser or same-origin web proxy", () => {
  assert.equal(appSource.includes("BrowserAgent"), false);
  assert.equal(appSource.includes("activeProjectorUrl"), false);
  assert.equal(serverSource.includes('/api/web-proxy'), false);
  assert.equal(serverSource.includes('/api/proxy'), false);
  assert.equal(serverSource.includes('/api/youtube-search'), false);
  assert.equal(serverSource.includes('X-Myraa-Proxied'), false);
  assert.equal(existsSync(path.join(root, "src", "components", "BrowserAgent.tsx")), false);
  assert.equal(existsSync(path.join(root, "local-agent.js")), false);
  assert.equal(existsSync(path.join(root, "desktop_agent", "tools_browser.py")), false);
});

test("privileged desktop surfaces stay on Sara's exact local origin", () => {
  assert.match(electronSource, /will-navigate/);
  assert.match(electronSource, /isTrustedRendererUrl\(webContents\.getURL\(\)\)/);
  assert.match(electronSource, /sandbox: true/);
  assert.match(serverSource, /parsed\.host\.toLowerCase\(\) === host\.trim\(\)\.toLowerCase\(\)/);
  assert.equal(agentMainSource.includes("CORSMiddleware"), false);
  assert.equal(agentMainSource.includes("allow_origins"), false);
});
