const { JSDOM } = require("jsdom");
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: "https://app.example.com/",
  pretendToBeVisual: true,
});
const g = globalThis;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.CustomEvent = dom.window.CustomEvent;
g.DOMException = dom.window.DOMException;
g.getComputedStyle = dom.window.getComputedStyle;
g.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
g.cancelAnimationFrame = (id) => clearTimeout(id);
const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
g.matchMedia = matchMedia;
dom.window.matchMedia = matchMedia;
g.ResizeObserver = dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
g.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
g.fetch = dom.window.fetch = async () => new Response(JSON.stringify({ ok: true, hasApiKey: true }), { status: 200, headers: { "Content-Type": "application/json" } });
Object.defineProperty(dom.window, "innerWidth", { value: 360, writable: true });
Object.defineProperty(dom.window, "innerHeight", { value: 800, writable: true });
class StubWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0;
  constructor() {}
  close() { this.readyState = 3; }
  send() {}
  addEventListener() {} removeEventListener() {}
}
g.WebSocket = dom.window.WebSocket = StubWebSocket;
g.HTMLCanvasElement = dom.window.HTMLCanvasElement;
dom.window.HTMLCanvasElement.prototype.getContext = () => null;
