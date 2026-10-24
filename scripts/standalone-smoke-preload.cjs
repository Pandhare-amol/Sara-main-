/**
 * jsdom environment for the standalone Sara Mobile smoke test.
 *
 * There is no Sara server in this app, so nothing is stubbed for `/api/*`.
 * `fetch` rejects on purpose: the sandbox has no Google key and no network to
 * Gemini, and the test asserts that the app *reports* that instead of pretending
 * an answer arrived.
 *
 * Note what is intentionally absent, because a real WebView may also lack it:
 * IndexedDB, MediaRecorder, speechSynthesis. The app has to degrade honestly.
 */
const { JSDOM } = require("jsdom");

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: "https://mobile.sara.local/",
  pretendToBeVisual: true,
});
const g = globalThis;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.CustomEvent = dom.window.CustomEvent;
g.DOMException = dom.window.DOMException;
g.FileReader = dom.window.FileReader;
g.getComputedStyle = dom.window.getComputedStyle;
g.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16);
g.cancelAnimationFrame = (id) => clearTimeout(id);

const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
g.matchMedia = matchMedia;
dom.window.matchMedia = matchMedia;
g.ResizeObserver = dom.window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// No network in this environment: the app must say so.
const offline = () => Promise.reject(new TypeError("Failed to fetch"));
g.fetch = dom.window.fetch = offline;

Object.defineProperty(dom.window, "innerWidth", { value: 380, writable: true });
Object.defineProperty(dom.window, "innerHeight", { value: 820, writable: true });
