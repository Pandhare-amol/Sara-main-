/**
 * Playback behaviour of the uploaded companion clip, in jsdom with a stubbed
 * media element.
 *
 * jsdom does not decode video, so this file proves the *control flow*: the clip
 * is asked to play, a blocked autoplay surfaces a tap-to-play control instead of
 * a silent frozen frame, paused/reduced-motion pauses it, and a decode failure
 * is reported upward. Whether a particular phone can decode a particular codec
 * is a device question and is not claimed here.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement, type ReactElement } from "react";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "https://app.example.com/",
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.CustomEvent = dom.window.CustomEvent;
g.DOMException = dom.window.DOMException;
g.requestAnimationFrame = (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);

let playCalls = 0;
let pauseCalls = 0;
let autoplayBlocked = false;

dom.window.HTMLMediaElement.prototype.play = function play() {
  playCalls += 1;
  if (autoplayBlocked) return Promise.reject(new dom.window.DOMException("blocked by policy", "NotAllowedError"));
  return Promise.resolve();
};
dom.window.HTMLMediaElement.prototype.pause = function pause() {
  pauseCalls += 1;
};

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { StageVideo } = await import("../src/mobile/StageVideo");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = async () => {
  await act(async () => {
    await sleep(10);
  });
};

let root: ReturnType<typeof createRoot> | null = null;
const container = () => dom.window.document.getElementById("root")!;

/** jsdom never decodes media, so tell the component a frame is ready. */
async function markReady() {
  const video = container().querySelector("video");
  if (!video) return;
  await act(async () => {
    video.dispatchEvent(new dom.window.Event("canplay"));
  });
  await flush();
}

function render(element: ReactElement) {
  if (!root) root = createRoot(container());
  act(() => {
    root!.render(element);
  });
}

function mount(props: Partial<Parameters<typeof StageVideo>[0]> = {}) {
  const errors: string[] = [];
  render(
    createElement(StageVideo, {
      url: "blob:https://app.example.com/clip",
      poster: null,
      muted: true,
      fit: "cover" as const,
      paused: false,
      onError: (message: string) => errors.push(message),
      ...props,
    }),
  );
  return errors;
}

before(() => {
  playCalls = 0;
  pauseCalls = 0;
});

after(async () => {
  if (root) await act(async () => root!.unmount());
});

test("the clip is asked to play when it appears", async () => {
  autoplayBlocked = false;
  mount();
  await flush();
  assert.ok(playCalls >= 1, "play() was called");
  const video = container().querySelector("video");
  assert.ok(video, "a real <video> element is rendered");
  assert.equal(video.getAttribute("loop"), "", "it loops");
  assert.equal(video.muted, true, "muted by default so her voice is the one you hear");
  assert.equal(video.getAttribute("playsinline"), "", "inline playback, no hijacked fullscreen player");
  assert.equal(video.style.objectFit, "cover", "framing preference is applied");
});

test("a blocked autoplay offers a tap instead of a frozen frame", async () => {
  autoplayBlocked = true;
  mount({ url: "blob:https://app.example.com/blocked" });
  await flush();
  await markReady();
  const tap = container().querySelector('[aria-label="Tap to play"]');
  assert.ok(tap, "tap-to-play control is shown");

  autoplayBlocked = false;
  await act(async () => {
    (tap as HTMLElement).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  assert.equal(container().querySelector('[aria-label="Tap to play"]'), null, "control disappears once it plays");
});

test("reduced motion holds the clip on its poster frame", async () => {
  autoplayBlocked = false;
  pauseCalls = 0;
  mount({ url: "blob:https://app.example.com/paused", paused: true, poster: "data:image/jpeg;base64,AAAA" });
  await flush();
  await markReady();
  assert.ok(pauseCalls >= 1, "the video is paused rather than played");
  const play = container().querySelector('[aria-label="Play companion video"]');
  assert.ok(play, "there is a way to start it deliberately");
  assert.equal(container().querySelector("video")?.getAttribute("poster"), "data:image/jpeg;base64,AAAA");
});

test("a clip the device cannot decode is reported, not swallowed", async () => {
  const errors = mount({ url: "blob:https://app.example.com/broken" });
  await flush();
  const video = container().querySelector("video")!;
  await act(async () => {
    video.dispatchEvent(new dom.window.Event("error"));
  });
  await flush();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /could not be played/i);
  assert.match(errors[0], /MP4/i, "the message says what to try instead");
});

test("sound is passed through when the user turns it on", async () => {
  mount({ url: "blob:https://app.example.com/sound", muted: false });
  await flush();
  assert.equal(container().querySelector("video")?.muted, false);
});
