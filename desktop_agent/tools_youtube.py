"""Verified YouTube control for the user's real Windows browser.

The adapter deliberately does not embed, proxy, scrape, or launch an automation
browser.  It reuses an active YouTube tab (or opens one new tab when none is
active), selects visible results through Windows UI Automation, uses YouTube's
semantic player controls / documented keyboard shortcuts, and synchronizes
state from the browser accessibility tree plus Windows' official System Media
Transport Controls (SMTC).

No control is reported as successful unless a fresh state probe verifies the
requested outcome.  Sign-in, age, region, missing-video, connectivity and
unsupported-player limitations are returned as blockers rather than bypassed.
"""
from __future__ import annotations

import asyncio
import math
import platform
from functools import wraps
import re
import threading
import time
from datetime import timedelta
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple
from urllib.parse import parse_qs, quote_plus, urlparse

from .registry import STATE, ToolError, register

_BROWSER_PROCESSES = {"chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe"}
_PLAYBACK_PATHS = {"/watch", "/live"}
_RATE_VALUES = {0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0}
_RESULT_EXACT_EXCLUSIONS = {
    "youtube home", "home", "shorts", "subscriptions", "history", "library", "you", "sign in",
    "skip navigation", "guide", "explore", "trending", "music", "movies & tv", "live", "gaming",
    "news", "sports", "learning", "fashion & beauty", "browse channels", "show more", "filters",
}
_RESTRICTIONS: Tuple[Tuple[str, str], ...] = (
    ("sign in to confirm your age", "AGE_RESTRICTED_SIGN_IN_REQUIRED"),
    ("age-restricted", "AGE_RESTRICTED_SIGN_IN_REQUIRED"),
    ("not available in your country", "REGION_RESTRICTED"),
    ("isn't available in your country", "REGION_RESTRICTED"),
    ("video unavailable", "VIDEO_UNAVAILABLE"),
    ("this video is private", "PRIVATE_VIDEO"),
    ("this content isn't available", "CONTENT_UNAVAILABLE"),
    ("you're offline", "CONNECTIVITY_ERROR"),
    ("connect to the internet", "CONNECTIVITY_ERROR"),
    ("something went wrong", "PLAYER_ERROR"),
)


def _require_windows() -> None:
    if platform.system() != "Windows":
        raise ToolError("YouTube player control is available only through the Windows desktop agent.")


def _cancel_event() -> threading.Event:
    event = getattr(STATE, "youtube_cancel", None)
    if event is None:
        with STATE.lock:
            event = getattr(STATE, "youtube_cancel", None)
            if event is None:
                event = threading.Event()
                setattr(STATE, "youtube_cancel", event)
    return event


def _stored_state() -> Dict[str, Any]:
    with STATE.lock:
        return dict(getattr(STATE, "youtube", {}) or {})


def _save_state(value: Dict[str, Any]) -> Dict[str, Any]:
    value = dict(value)
    value["updated_at"] = time.time()
    with STATE.lock:
        setattr(STATE, "youtube", value)
    return value


def _check_cancelled() -> None:
    if _cancel_event().is_set():
        state = _stored_state()
        state.update({"task_status": "cancelled", "error": "YouTube operation cancelled."})
        _save_state(state)
        raise ToolError("CANCELLED: YouTube operation cancelled.")


def _record_failures(fn):
    @wraps(fn)
    def wrapped(args: Dict[str, Any]) -> Dict[str, Any]:
        try:
            return fn(args)
        except ToolError as exc:
            message = str(exc)
            code = message.split(":", 1)[0] if ":" in message else "YOUTUBE_ERROR"
            state = _stored_state()
            state.update({
                "task_status": "cancelled" if code == "CANCELLED" else "blocked",
                "error_code": code,
                "error": message,
                "verified": False,
            })
            _save_state(state)
            raise
    return wrapped


def _is_youtube_url(value: Any) -> bool:
    try:
        host = (urlparse(str(value)).hostname or "").casefold().rstrip(".")
        return host == "youtu.be" or host == "youtube.com" or host.endswith(".youtube.com")
    except Exception:
        return False


def _is_playback_url(value: Any) -> bool:
    if not _is_youtube_url(value):
        return False
    parsed = urlparse(str(value))
    return parsed.path in _PLAYBACK_PATHS or parsed.path.startswith("/shorts/")


def _video_id(value: Any) -> Optional[str]:
    if not _is_youtube_url(value):
        return None
    parsed = urlparse(str(value))
    host = (parsed.hostname or "").casefold()
    if host == "youtu.be":
        candidate = parsed.path.strip("/").split("/")[0]
    elif parsed.path.startswith("/shorts/") or parsed.path.startswith("/live/"):
        parts = parsed.path.strip("/").split("/")
        candidate = parts[1] if len(parts) > 1 else ""
    else:
        candidate = (parse_qs(parsed.query).get("v") or [""])[0]
    return candidate if re.fullmatch(r"[A-Za-z0-9_-]{6,20}", candidate or "") else None


def _playlist_id(value: Any) -> Optional[str]:
    if not _is_youtube_url(value):
        return None
    candidate = (parse_qs(urlparse(str(value)).query).get("list") or [""])[0]
    return candidate if re.fullmatch(r"[A-Za-z0-9_-]{6,80}", candidate or "") else None


def _clean_browser_title(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    text = re.sub(r"\s*[-–—]\s*YouTube(?:\s*[-–—].*)?$", "", text, flags=re.IGNORECASE).strip()
    return text or None


def _normalize(value: Any) -> str:
    return " ".join(re.findall(r"[\w]+", str(value or "").casefold()))


def _tokens(value: Any) -> set[str]:
    return {token for token in _normalize(value).split() if len(token) > 1}


def _browser_state(hwnd: int) -> Dict[str, Any]:
    from .tools_uia import browser_state

    return browser_state({"hwnd": int(hwnd)})


def _foreground_hwnd() -> Optional[int]:
    try:
        import win32gui

        value = int(win32gui.GetForegroundWindow())
        return value or None
    except Exception:
        return None


def _visible_browser_hwnds(limit: int = 12) -> List[int]:
    import psutil
    import win32gui
    import win32process

    found: List[int] = []

    def callback(hwnd, _unused):
        if len(found) >= limit or not win32gui.IsWindowVisible(hwnd) or not win32gui.GetWindowText(hwnd):
            return True
        try:
            _thread, pid = win32process.GetWindowThreadProcessId(hwnd)
            if psutil.Process(pid).name().casefold() in _BROWSER_PROCESSES:
                found.append(int(hwnd))
        except Exception:
            pass
        return True

    win32gui.EnumWindows(callback, None)
    return found


def _valid_stored_fullscreen(hwnd: int, stored: Dict[str, Any]) -> bool:
    """Address bars disappear in full screen; accept only our verified HWND."""
    if int(stored.get("browser_hwnd") or 0) != int(hwnd) or not _is_playback_url(stored.get("url")):
        return False
    try:
        import win32gui

        return bool(win32gui.IsWindow(hwnd) and win32gui.IsWindowVisible(hwnd))
    except Exception:
        return False


def _find_youtube_window(required: bool = True) -> Tuple[Optional[int], Optional[Dict[str, Any]]]:
    _require_windows()
    stored = _stored_state()
    checked: Dict[int, Dict[str, Any]] = {}
    preferred = [int(stored.get("browser_hwnd") or 0), int(_foreground_hwnd() or 0)]
    for hwnd in preferred + _visible_browser_hwnds():
        if not hwnd or hwnd in checked:
            continue
        try:
            state = _browser_state(hwnd)
        except Exception:
            continue
        checked[hwnd] = state
        if _is_youtube_url(state.get("url")):
            return hwnd, state
        if _valid_stored_fullscreen(hwnd, stored):
            state["url"] = stored.get("url")
            return hwnd, state
    if required:
        raise ToolError("YOUTUBE_TAB_NOT_FOUND: no active, verified YouTube tab is available. Ask to play or search for a video first.")
    return None, None


def _focus(hwnd: int) -> None:
    from .tools_windows import _focus as focus_window

    focus_window(int(hwnd))


def _navigate_youtube(url: str) -> Tuple[int, Dict[str, Any]]:
    """Reuse only a verified YouTube tab; otherwise open exactly one new tab."""
    _check_cancelled()
    existing, _state = _find_youtube_window(required=False)
    from .tools_websites import open_url

    if existing:
        _focus(existing)
        open_url(url, reuse_current_tab=True)
    else:
        # Do not replace an unrelated active tab. ShellExecute opens one new
        # tab in the user's default browser and leaves all other tabs intact.
        open_url(url, reuse_current_tab=False)
    deadline = time.monotonic() + 12.0
    last: Optional[Dict[str, Any]] = None
    while time.monotonic() < deadline:
        _check_cancelled()
        hwnd = _foreground_hwnd()
        if hwnd:
            try:
                last = _browser_state(hwnd)
                if _is_youtube_url(last.get("url")):
                    state = _stored_state()
                    state.update({"browser_hwnd": hwnd, "url": last.get("url"), "task_status": "navigating", "error": None})
                    _save_state(state)
                    return hwnd, last
            except Exception:
                pass
        time.sleep(0.25)
    detail = f" ({last.get('title')})" if last else ""
    raise ToolError(f"YOUTUBE_NAVIGATION_FAILED: the default browser did not expose the requested YouTube page{detail}.")


def _inspect(hwnd: int, roles: Iterable[str], max_elements: int = 360) -> Dict[str, Any]:
    from .tools_uia import inspect_ui

    return inspect_ui({"hwnd": int(hwnd), "roles": list(roles), "max_elements": max_elements})


def _result_candidates(elements: List[Dict[str, Any]], query: str, kind: str = "video") -> List[Dict[str, Any]]:
    """Return semantic result links in visual order, excluding YouTube chrome.

    This intentionally relies only on the accessibility names visible to the
    user.  A clicked candidate is not trusted until the browser URL changes to
    a real watch/Shorts page (and to a playlist context when requested).
    """
    semantic_targets = []
    seen_targets: set[str] = set()
    for element in elements:
        target = str(element.get("target_url") or "")
        if not target or not _is_youtube_url(target):
            continue
        playable = _is_playback_url(target)
        playlist = bool(_playlist_id(target)) or urlparse(target).path == "/playlist"
        if kind == "playlist" and not playlist:
            continue
        if kind == "video" and not playable:
            continue
        identity = _video_id(target) or _playlist_id(target) or target
        if identity in seen_targets:
            continue
        seen_targets.add(identity)
        semantic_targets.append(element)
    if semantic_targets:
        return semantic_targets

    wanted = _tokens(query)
    seen: set[str] = set()
    candidates: List[Tuple[int, int, Dict[str, Any]]] = []
    for order, element in enumerate(elements):
        if element.get("role") != "link" or element.get("enabled") is False:
            continue
        name = " ".join(str(element.get("name") or "").split()).strip()
        normalized = _normalize(name)
        if not normalized or normalized in _RESULT_EXACT_EXCLUSIONS or len(name) < 3 or len(name) > 300:
            continue
        if normalized.startswith(("http ", "youtube home", "skip navigation", "sign in")):
            continue
        if normalized in {"terms", "privacy", "policy safety", "how youtube works", "test new features"}:
            continue
        rect = element.get("rect") if isinstance(element.get("rect"), dict) else {}
        if int(rect.get("top") or 0) < 70:
            continue
        playlist_like = "playlist" in normalized or normalized.startswith("mix ") or "view full playlist" in normalized
        if kind == "playlist" and not playlist_like:
            continue
        if kind == "video" and normalized in {"channels", "playlists"}:
            continue
        dedupe = re.sub(r"\b\d[\d:,.]*\b", "", normalized).strip()
        if dedupe in seen:
            continue
        seen.add(dedupe)
        overlap = len(wanted & _tokens(name))
        # Preserve YouTube's visible order. The score is used only to demote
        # unrelated footer/navigation links that survived the static filter.
        relevance_band = 0 if overlap or not wanted else 1
        candidates.append((relevance_band, order, element))
    candidates.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in candidates]


def _invoke_element(snapshot: Dict[str, Any], element: Dict[str, Any]) -> Dict[str, Any]:
    from .tools_uia import ui_action

    return ui_action({"element_id": element["id"], "snapshot_id": snapshot["snapshot_id"], "action": "click", "method": "auto"})


def _wait_for_url(hwnd: int, predicate: Callable[[str], bool], timeout: float = 10.0) -> Optional[Dict[str, Any]]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        _check_cancelled()
        try:
            state = _browser_state(hwnd)
            if predicate(str(state.get("url") or "")):
                return state
            if state.get("loading") is False:
                time.sleep(0.2)
            else:
                time.sleep(0.35)
        except Exception:
            time.sleep(0.25)
    return None


def _go_back(hwnd: int) -> None:
    _focus(hwnd)
    import pyautogui

    pyautogui.hotkey("alt", "left")
    _wait_for_url(hwnd, lambda url: "/results" in url or "/playlist" in url, 6.0)


def _select_visible_result(hwnd: int, query: str, index: int, kind: str) -> Dict[str, Any]:
    # Web accessibility trees may expose a channel link between two video-title
    # links. Treat only a link that reaches a verified player/playlist as a
    # result, skipping at most six non-player links without guessing.
    candidate_position = index - 1
    last_name = ""
    for _attempt in range(6):
        snapshot = _inspect(hwnd, ["link"], 420)
        elements = snapshot.get("elements") or []
        semantic_targets_available = any(element.get("target_url") for element in elements)
        if index > 1 and not semantic_targets_available:
            raise ToolError("YOUTUBE_RESULT_INDEX_UNVERIFIABLE: this browser did not expose semantic YouTube link targets, so selecting a numbered result could confuse a channel link with a video. Choose by exact visible title or use a browser that exposes accessible link targets.")
        candidates = _result_candidates(elements, query, kind)
        if index < 1 or candidate_position >= len(candidates):
            raise ToolError(f"YOUTUBE_RESULT_NOT_FOUND: visible {kind} result {index} is unavailable (found {len(candidates)} candidate links).")
        candidate = candidates[candidate_position]
        last_name = str(candidate.get("name") or "")
        before_url = str(_browser_state(hwnd).get("url") or "")
        _invoke_element(snapshot, candidate)
        loaded = _wait_for_url(hwnd, lambda url: _is_playback_url(url) or (kind == "playlist" and "/playlist" in url), 10.0)
        if loaded and kind == "playlist" and not _is_playback_url(loaded.get("url")):
            # Playlist landing pages are not playback. Select their first
            # visible video semantically, then verify list context remains.
            playlist_snapshot = _inspect(hwnd, ["link"], 420)
            playlist_candidates = _result_candidates(playlist_snapshot.get("elements") or [], query, "video")
            if not playlist_candidates:
                raise ToolError("YOUTUBE_PLAYLIST_EMPTY: the selected playlist exposes no playable video.")
            last_name = str(playlist_candidates[0].get("name") or last_name)
            _invoke_element(playlist_snapshot, playlist_candidates[0])
            loaded = _wait_for_url(hwnd, _is_playback_url, 10.0)
        if loaded and _is_playback_url(loaded.get("url")) and (kind != "playlist" or _playlist_id(loaded.get("url"))):
            return {"selected_title": last_name, "browser": loaded}
        try:
            current_url = str(_browser_state(hwnd).get("url") or "")
        except Exception:
            current_url = ""
        if current_url and current_url != before_url and "/results" not in current_url:
            _go_back(hwnd)
        candidate_position += 1
    raise ToolError(f"YOUTUBE_SELECTION_FAILED: accessible links near result {index} did not open a verifiable {kind} player (last tried: '{last_name}').")


def _seconds(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, timedelta):
        return max(0.0, value.total_seconds())
    try:
        # WinRT TimeSpan values may be projected as 100-nanosecond ticks.
        number = float(value)
        return max(0.0, number / 10_000_000 if number > 10_000_000 else number)
    except (TypeError, ValueError):
        return None


async def _media_session(operation: Optional[str] = None, value: Optional[float] = None, title_hint: str = "") -> Optional[Dict[str, Any]]:
    """Read/control the active browser media session through official SMTC."""
    try:
        from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
    except ImportError:
        return None
    try:
        manager = await GlobalSystemMediaTransportControlsSessionManager.request_async()
        sessions = list(manager.get_sessions())
        current = manager.get_current_session()
        ordered = ([current] if current is not None else []) + [item for item in sessions if item is not current]
        hint = _tokens(_clean_browser_title(title_hint) or title_hint)
        ranked: List[Tuple[int, Any, Any]] = []
        for session in ordered:
            source = str(getattr(session, "source_app_user_model_id", "") or "").casefold()
            if not any(browser.replace(".exe", "") in source for browser in _BROWSER_PROCESSES):
                continue
            try:
                props = await session.try_get_media_properties_async()
            except Exception:
                props = None
            title = str(getattr(props, "title", "") or "")
            score = len(hint & _tokens(title)) * 10 + (2 if session is current else 0)
            ranked.append((score, session, props))
        if not ranked:
            return None
        ranked.sort(key=lambda item: item[0], reverse=True)
        _score, session, props = ranked[0]
        succeeded: Optional[bool] = None
        if operation:
            methods = {
                "play": "try_play_async", "pause": "try_pause_async", "next": "try_skip_next_async",
                "previous": "try_skip_previous_async", "stop": "try_stop_async",
            }
            if operation == "seek":
                method = getattr(session, "try_change_playback_position_async", None)
                if method is not None and value is not None:
                    succeeded = bool(await method(int(max(0.0, value) * 10_000_000)))
            elif operation in methods:
                method = getattr(session, methods[operation], None)
                if method is not None:
                    succeeded = bool(await method())
            await asyncio.sleep(0.18)
            try:
                props = await session.try_get_media_properties_async()
            except Exception:
                pass
        info = session.get_playback_info()
        timeline = session.get_timeline_properties()
        status_text = str(getattr(info, "playback_status", "") or "").casefold()
        status = "unknown"
        for candidate in ("playing", "paused", "stopped", "changing", "closed"):
            if candidate in status_text:
                status = "buffering" if candidate == "changing" else candidate
                break
        return {
            "title": str(getattr(props, "title", "") or "") or None,
            "artist": str(getattr(props, "artist", "") or "") or None,
            "playback_state": status,
            "position_seconds": _seconds(getattr(timeline, "position", None)),
            "duration_seconds": _seconds(getattr(timeline, "end_time", None)),
            "source": str(getattr(session, "source_app_user_model_id", "") or ""),
            "command_succeeded": succeeded,
        }
    except Exception:
        return None


def _read_media(title_hint: str = "") -> Optional[Dict[str, Any]]:
    try:
        return asyncio.run(_media_session(title_hint=title_hint))
    except Exception:
        return None


def _media_command(operation: str, value: Optional[float], title_hint: str) -> Optional[Dict[str, Any]]:
    try:
        return asyncio.run(_media_session(operation, value, title_hint))
    except Exception:
        return None


def _uia_player_state(hwnd: int) -> Dict[str, Any]:
    try:
        snapshot = _inspect(hwnd, ["button", "slider", "menuitem", "text"], 380)
    except Exception:
        return {"elements": [], "verified_fields": []}
    elements = snapshot.get("elements") or []
    names = [(element, _normalize(element.get("name"))) for element in elements]
    result: Dict[str, Any] = {"snapshot": snapshot, "elements": elements, "verified_fields": []}
    if any(name.startswith("pause") and "k" in name for _element, name in names):
        result["playback_state"] = "playing"
        result["verified_fields"].append("playback_state")
    elif any((name == "play" or name.startswith("play k")) for _element, name in names):
        result["playback_state"] = "paused"
        result["verified_fields"].append("playback_state")
    if any(name.startswith("unmute") for _element, name in names):
        result["muted"] = True
        result["verified_fields"].append("muted")
    elif any(name.startswith("mute") for _element, name in names):
        result["muted"] = False
        result["verified_fields"].append("muted")
    for element, name in names:
        if element.get("role") != "slider" or "volume" not in name:
            continue
        numeric = element.get("value")
        minimum, maximum = element.get("minimum"), element.get("maximum")
        if isinstance(numeric, (int, float)) and isinstance(minimum, (int, float)) and isinstance(maximum, (int, float)) and maximum > minimum:
            percent = round((float(numeric) - float(minimum)) * 100 / (float(maximum) - float(minimum)))
        else:
            raw = str(element.get("value") if element.get("value") is not None else element.get("name") or "")
            match = re.search(r"(\d{1,3})(?:\s*%)?", raw)
            percent = int(match.group(1)) if match else -1
        if 0 <= percent <= 100:
            result["volume_percent"] = percent
            result["volume_element"] = element
            result["verified_fields"].append("volume_percent")
            break
    caption = next(((element, name) for element, name in names if "subtitles" in name or "closed captions" in name), None)
    if caption:
        element, _name = caption
        if isinstance(element.get("checked"), bool):
            result["captions_enabled"] = element["checked"]
            result["verified_fields"].append("captions_enabled")
        result["caption_element"] = element
    if any(name.startswith("exit full screen") or name.startswith("exit fullscreen") for _element, name in names):
        result["fullscreen"] = True
        result["verified_fields"].append("fullscreen")
    elif any(name.startswith("full screen") or name.startswith("fullscreen") for _element, name in names):
        result["fullscreen"] = False
        result["verified_fields"].append("fullscreen")
    for element, name in names:
        match = re.search(r"playback speed\s+(0\.25|0\.5|0\.75|1(?:\.0)?|1\.25|1\.5|1\.75|2(?:\.0)?)", name)
        if match:
            result["playback_rate"] = float(match.group(1))
            result["verified_fields"].append("playback_rate")
            break
    visible_text = "\n".join(str(element.get("name") or "") for element in elements).casefold()
    for marker, code in _RESTRICTIONS:
        if marker in visible_text:
            result["error_code"] = code
            result["error"] = marker
            break
    return result


def _probe_state(hwnd: Optional[int] = None, *, include_ui: bool = True, task_status: Optional[str] = None) -> Dict[str, Any]:
    if hwnd is None:
        hwnd, browser = _find_youtube_window(required=True)
    else:
        browser = _browser_state(hwnd)
        if not _is_youtube_url(browser.get("url")):
            stored = _stored_state()
            if not _valid_stored_fullscreen(hwnd, stored):
                raise ToolError("UNRELATED_TAB_ACTIVE: the selected browser window is no longer showing YouTube.")
            browser["url"] = stored.get("url")
    assert hwnd is not None
    stored = _stored_state()
    media = _read_media(str(browser.get("title") or "")) or {}
    ui = _uia_player_state(hwnd) if include_ui else {}
    url = str(browser.get("url") or stored.get("url") or "")
    title = media.get("title") or _clean_browser_title(browser.get("title")) or stored.get("title")
    state: Dict[str, Any] = {
        "active": _is_youtube_url(url),
        "browser_hwnd": int(hwnd),
        "browser": browser.get("browser"),
        "title": title,
        "channel": media.get("artist"),
        "url": url or None,
        "video_id": _video_id(url),
        "playlist_id": _playlist_id(url),
        "playback_state": media.get("playback_state") if media.get("playback_state") not in {None, "unknown"} else ui.get("playback_state", "unknown"),
        "position_seconds": media.get("position_seconds"),
        "duration_seconds": media.get("duration_seconds"),
        "volume_percent": ui.get("volume_percent"),
        "muted": ui.get("muted"),
        "fullscreen": ui.get("fullscreen"),
        "captions_enabled": ui.get("captions_enabled"),
        "playback_rate": ui.get("playback_rate"),
        "search_query": stored.get("search_query"),
        "result_index": stored.get("result_index"),
        "selection_kind": stored.get("selection_kind"),
        "requested_channel": stored.get("requested_channel"),
        "latest_filter_applied": bool(stored.get("latest_filter_applied")),
        "task_status": task_status or stored.get("task_status") or "idle",
        "error_code": ui.get("error_code"),
        "error": ui.get("error"),
        "verified_fields": sorted(set(
            (["url", "video_id"] if _is_playback_url(url) and _video_id(url) else ["url"] if _is_youtube_url(url) else [])
            + (["title"] if title else [])
            + (["channel"] if media.get("artist") else [])
            + (["playback_state", "position_seconds", "duration_seconds"] if media else [])
            + list(ui.get("verified_fields") or [])
        )),
    }
    if state["playback_state"] == "paused" and isinstance(state.get("position_seconds"), (int, float)):
        state["stopped"] = float(state["position_seconds"]) <= 4.0
        state["verified_fields"] = sorted(set(list(state["verified_fields"]) + ["stopped"]))
    else:
        state["stopped"] = False
    if state["error_code"]:
        state["task_status"] = "blocked"
    return _save_state(state)


def _wait_state(hwnd: int, predicate: Callable[[Dict[str, Any]], bool], timeout: float, *, include_ui: bool = False) -> Dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: Dict[str, Any] = {}
    while time.monotonic() < deadline:
        _check_cancelled()
        try:
            last = _probe_state(hwnd, include_ui=include_ui)
            if predicate(last):
                return last
        except Exception:
            pass
        time.sleep(0.32)
    return _probe_state(hwnd, include_ui=True)


def _matching_element(snapshot: Dict[str, Any], predicate: Callable[[Dict[str, Any], str], bool]) -> Optional[Dict[str, Any]]:
    for element in snapshot.get("elements") or []:
        name = _normalize(element.get("name"))
        if predicate(element, name):
            return element
    return None


def _click_player_control(hwnd: int, predicate: Callable[[Dict[str, Any], str], bool]) -> bool:
    player = _uia_player_state(hwnd)
    snapshot = player.get("snapshot")
    if not snapshot:
        return False
    element = _matching_element(snapshot, predicate)
    if not element:
        return False
    _invoke_element(snapshot, element)
    return True


def _press(keys: List[str], presses: int = 1) -> None:
    import pyautogui

    for _index in range(max(1, presses)):
        _check_cancelled()
        if len(keys) == 1:
            pyautogui.press(keys[0])
        else:
            pyautogui.hotkey(*keys)
        if presses > 1:
            time.sleep(0.04)


def _play_or_pause(hwnd: int, desired: str, before: Dict[str, Any]) -> Dict[str, Any]:
    if before.get("playback_state") == desired:
        return before
    media = _media_command("play" if desired == "playing" else "pause", None, str(before.get("title") or ""))
    if not media or media.get("command_succeeded") is not True:
        expected_button = "play" if desired == "playing" else "pause"
        clicked = _click_player_control(
            hwnd,
            lambda _element, name: name == expected_button or name.startswith(expected_button + " "),
        )
        if not clicked:
            if before.get("playback_state") not in {"playing", "paused"}:
                raise ToolError("PLAYER_STATE_UNAVAILABLE: cannot safely use a play/pause toggle because the current player state is unverified.")
            _focus(hwnd)
            _press(["k"])
    after = _wait_state(hwnd, lambda state: state.get("playback_state") == desired, 6.0)
    if after.get("playback_state") != desired:
        code = after.get("error_code")
        if code:
            raise ToolError(f"{code}: YouTube blocked playback ({after.get('error')}).")
        if desired == "playing":
            raise ToolError("AUTOPLAY_BLOCKED: YouTube did not enter playing state after an explicit user-requested play action. Click the player once or resolve any sign-in/restriction prompt.")
        raise ToolError("PLAYER_CONTROL_UNVERIFIED: YouTube did not enter paused state.")
    return after


def _seek(hwnd: int, target: float, before: Dict[str, Any]) -> Dict[str, Any]:
    target = max(0.0, float(target))
    duration = before.get("duration_seconds")
    if isinstance(duration, (int, float)) and duration > 0:
        target = min(target, float(duration))
    media = _media_command("seek", target, str(before.get("title") or ""))
    if not media or media.get("command_succeeded") is not True:
        if target == 0:
            _focus(hwnd)
            _press(["0"])
        elif isinstance(duration, (int, float)) and duration > 0:
            tenth = round(target / float(duration) * 10)
            if 0 <= tenth <= 9 and abs(target - float(duration) * tenth / 10) <= max(2.0, float(duration) * 0.025):
                _focus(hwnd)
                _press([str(tenth)])
            else:
                raise ToolError("SEEK_UNSUPPORTED: this browser exposes no SMTC seek control, and the requested absolute time is not a YouTube 10% shortcut.")
        else:
            raise ToolError("SEEK_UNSUPPORTED: the active player exposes neither a media-session seek control nor a verified duration.")
    after = _wait_state(hwnd, lambda state: isinstance(state.get("position_seconds"), (int, float)) and abs(float(state["position_seconds"]) - target) <= 3.5, 6.0)
    if not isinstance(after.get("position_seconds"), (int, float)) or abs(float(after["position_seconds"]) - target) > 4.0:
        raise ToolError("SEEK_UNVERIFIED: the player did not report the requested playback position.")
    return after


def _set_volume(hwnd: int, percent: int) -> Dict[str, Any]:
    percent = max(0, min(100, int(percent)))
    player = _uia_player_state(hwnd)
    snapshot = player.get("snapshot")
    element = player.get("volume_element")
    if not snapshot or not element:
        raise ToolError("PLAYER_VOLUME_UNSUPPORTED: YouTube's player-volume slider is not exposed through accessibility in this browser. System volume was not changed.")
    from .tools_uia import ui_action

    actions = element.get("actions") if isinstance(element.get("actions"), list) else []
    if "range_value" in actions and isinstance(element.get("minimum"), (int, float)) and isinstance(element.get("maximum"), (int, float)):
        minimum, maximum = float(element["minimum"]), float(element["maximum"])
        requested = minimum + (maximum - minimum) * percent / 100
        ui_action({"element_id": element["id"], "snapshot_id": snapshot["snapshot_id"], "action": "set_range_value", "value": str(requested)})
    else:
        ui_action({"element_id": element["id"], "snapshot_id": snapshot["snapshot_id"], "action": "set_value", "value": str(percent)})
    after = _wait_state(hwnd, lambda state: state.get("volume_percent") == percent, 4.0, include_ui=True)
    if after.get("volume_percent") != percent:
        raise ToolError("PLAYER_VOLUME_UNVERIFIED: the YouTube player did not report the requested volume. System volume was not treated as player volume.")
    return after


def _set_speed(hwnd: int, rate: float) -> Dict[str, Any]:
    if rate not in _RATE_VALUES:
        raise ToolError("Unsupported YouTube playback speed. Choose 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75 or 2.")
    if not _click_player_control(hwnd, lambda _element, name: name == "settings" or name.startswith("settings ")):
        raise ToolError("PLAYBACK_SPEED_UNSUPPORTED: the YouTube Settings control is not exposed through accessibility.")
    time.sleep(0.25)
    menu = _inspect(hwnd, ["button", "menuitem", "text"], 260)
    speed = _matching_element(menu, lambda _element, name: name == "playback speed" or name.startswith("playback speed "))
    if not speed:
        raise ToolError("PLAYBACK_SPEED_UNSUPPORTED: the player Settings menu has no accessible Playback speed item.")
    _invoke_element(menu, speed)
    time.sleep(0.2)
    choices = _inspect(hwnd, ["button", "menuitem", "radio", "text"], 260)
    labels = {1.0: {"normal", "1", "1 0"}}
    target_labels = labels.get(rate, {str(rate), str(rate).replace(".", " ")})
    choice = _matching_element(choices, lambda element, name: name in target_labels or name.startswith(f"{str(rate).replace('.', ' ')} "))
    if not choice:
        raise ToolError(f"PLAYBACK_SPEED_UNSUPPORTED: speed {rate:g} is not present in the accessible menu.")
    _invoke_element(choices, choice)
    time.sleep(0.25)
    # Re-open and verify that the requested item is selected/checked. Clicking
    # a menu item alone is not proof because browser extensions/themes vary.
    _click_player_control(hwnd, lambda _element, name: name == "settings" or name.startswith("settings "))
    time.sleep(0.2)
    verify_menu = _inspect(hwnd, ["button", "menuitem", "text"], 260)
    speed_item = _matching_element(verify_menu, lambda _element, name: name.startswith("playback speed"))
    speed_label = _normalize(speed_item.get("name")) if speed_item else ""
    verified = bool(speed_item and ((rate == 1.0 and "normal" in speed_label) or str(rate).rstrip("0").rstrip(".") in str(speed_item.get("name") or "")))
    _press(["escape"])
    if not verified:
        raise ToolError("PLAYBACK_SPEED_UNVERIFIED: the accessible Settings menu did not report the chosen rate.")
    after = _probe_state(hwnd, include_ui=True)
    after["playback_rate"] = rate
    after["verified_fields"] = sorted(set(list(after.get("verified_fields") or []) + ["playback_rate"]))
    return _save_state(after)


@register("youtubeState")
@_record_failures
def youtube_state(_args: Dict[str, Any]) -> Dict[str, Any]:
    try:
        hwnd, _browser = _find_youtube_window(required=False)
        if not hwnd:
            stored = _stored_state()
            return {
                "result": "No active verified YouTube tab.", "active": False, "task_status": stored.get("task_status", "idle"),
                "error": stored.get("error"), "verified_fields": [],
            }
        state = _probe_state(hwnd, include_ui=True)
        state["result"] = f"YouTube: {state.get('title') or 'unknown title'} — {state.get('playback_state', 'unknown')} at {state.get('url') or 'unknown URL'}."
        return state
    except ToolError:
        raise
    except Exception as exc:
        raise ToolError(f"YOUTUBE_STATE_FAILED: {exc}") from exc


@register("youtubeCancel")
def youtube_cancel(_args: Dict[str, Any]) -> Dict[str, Any]:
    _cancel_event().set()
    state = _stored_state()
    state.update({"task_status": "cancelled", "error": "YouTube operation cancelled."})
    _save_state(state)
    return {"result": "Cancelled the pending YouTube operation. Current playback was not changed.", "cancelled": True, "verified": True}


@register("youtubePlay")
@_record_failures
def youtube_play(args: Dict[str, Any]) -> Dict[str, Any]:
    _require_windows()
    cancel = _cancel_event()
    cancel.clear()
    query = " ".join(str(args.get("query") or "").split()).strip()
    direct_url = str(args.get("url") or "").strip()
    channel = " ".join(str(args.get("channel") or "").split()).strip()
    latest = bool(args.get("latest", False))
    kind = "playlist" if bool(args.get("playlist", False)) or str(args.get("selection") or "").casefold() == "playlist" else "video"
    try:
        result_index = int(args.get("result_index") or 1)
    except (TypeError, ValueError):
        raise ToolError("result_index must be a positive integer.")
    if result_index < 1 or result_index > 50:
        raise ToolError("result_index must be between 1 and 50.")
    if direct_url and not _is_youtube_url(direct_url):
        raise ToolError("Only youtube.com or youtu.be URLs are accepted by youtubePlay.")
    if not direct_url and not query:
        raise ToolError("youtubePlay requires a search query or YouTube URL.")
    search_query = " ".join(item for item in [query, channel, "playlist" if kind == "playlist" else ""] if item).strip()
    initial = {
        **_stored_state(),
        "search_query": query or None,
        "result_index": result_index,
        "selection_kind": kind,
        "requested_channel": channel or None,
        "latest_filter_applied": latest,
        "task_status": "searching" if not direct_url else "opening",
        "error": None,
        "error_code": None,
    }
    _save_state(initial)
    if direct_url:
        hwnd, browser = _navigate_youtube(direct_url)
        if not _is_playback_url(browser.get("url")):
            if "/playlist" in str(browser.get("url") or ""):
                selection = _select_visible_result(hwnd, query or channel or "playlist", 1, "video")
                browser = selection["browser"]
            else:
                raise ToolError("YOUTUBE_URL_NOT_PLAYABLE: the requested URL is not a watch, Shorts, live, or playable playlist page.")
        selected_title = _clean_browser_title(browser.get("title"))
    else:
        # CAISAhAB is the upload-date + video filter generated by YouTube's own
        # Search filters UI. It narrows "latest" without claiming an API-level
        # guarantee about a channel whose identity cannot be verified.
        suffix = "&sp=CAISAhAB" if latest and kind == "video" else ""
        search_url = f"https://www.youtube.com/results?search_query={quote_plus(search_query)}{suffix}"
        hwnd, _browser = _navigate_youtube(search_url)
        loaded = _wait_for_url(hwnd, lambda url: "/results" in url, 10.0)
        if not loaded:
            raise ToolError("YOUTUBE_SEARCH_FAILED: YouTube search results did not finish loading.")
        selection = _select_visible_result(hwnd, search_query, result_index, kind)
        selected_title = selection["selected_title"]
    state = _probe_state(hwnd, include_ui=True, task_status="selected")
    if state.get("error_code"):
        raise ToolError(f"{state['error_code']}: YouTube reported '{state.get('error')}'.")
    if not _is_playback_url(state.get("url")) or not state.get("video_id"):
        raise ToolError("YOUTUBE_SELECTION_UNVERIFIED: the browser is not on a verifiable video URL.")
    if kind == "playlist" and not state.get("playlist_id"):
        raise ToolError("YOUTUBE_PLAYLIST_UNVERIFIED: the active video has no playlist context.")
    channel_verified = None
    if channel:
        media_channel = str(state.get("channel") or "")
        channel_verified = bool(_tokens(channel) and _tokens(channel) <= _tokens(media_channel))
        if not channel_verified:
            raise ToolError(
                f"CHANNEL_UNVERIFIED: selected '{state.get('title') or selected_title}', but the player did not verify the requested channel '{channel}'"
                + (f" (reported channel: '{media_channel}')." if media_channel else ". The browser exposes no channel metadata through SMTC.")
            )
    if bool(args.get("start_playback", True)):
        state = _play_or_pause(hwnd, "playing", state)
    state["task_status"] = "playing" if state.get("playback_state") == "playing" else "selected"
    state["result_index"] = result_index
    state["selection_kind"] = kind
    state["requested_channel"] = channel or None
    state["latest_filter_applied"] = latest
    state["channel_constraint_verified"] = channel_verified
    state["selected_result_title"] = selected_title
    state["verified"] = bool(
        _is_playback_url(state.get("url"))
        and state.get("video_id")
        and (not bool(args.get("start_playback", True)) or state.get("playback_state") == "playing")
        and (not channel or channel_verified)
        and (kind != "playlist" or state.get("playlist_id"))
    )
    if not state["verified"]:
        raise ToolError("YOUTUBE_PLAYBACK_UNVERIFIED: the requested watch page or playback state could not be verified.")
    state["result"] = (
        f"Verified YouTube playback: {state.get('title') or selected_title}"
        f" ({state.get('url')}); state={state.get('playback_state')}."
        + (" YouTube's upload-date search filter was applied." if latest else "")
    )
    return _save_state(state)


@register("youtubeControl")
@_record_failures
def youtube_control(args: Dict[str, Any]) -> Dict[str, Any]:
    _require_windows()
    action = str(args.get("action") or "").strip().casefold().replace("-", "_").replace(" ", "_")
    aliases = {
        "resume": "play", "replay": "restart", "start_over": "restart", "beginning": "restart",
        "skip": "next", "skip_video": "next", "different": "another", "another_result": "another",
        "related": "next", "mute_toggle": "toggle_mute", "full_screen": "fullscreen",
        "cc": "captions", "subtitles": "captions", "speed": "set_speed",
        "seek_forward": "forward", "seek_backward": "backward", "rewind": "backward",
    }
    action = aliases.get(action, action)
    allowed = {
        "play", "pause", "stop", "restart", "next", "previous", "another", "forward", "backward",
        "seek", "seek_percent", "middle", "set_volume", "volume_up", "volume_down", "mute", "unmute",
        "toggle_mute", "fullscreen", "enter_fullscreen", "exit_fullscreen", "captions", "captions_on",
        "captions_off", "set_speed", "cancel",
    }
    if action not in allowed:
        raise ToolError(f"Unsupported YouTube control '{action}'.")
    if action == "cancel":
        return youtube_cancel({})
    _cancel_event().clear()
    hwnd, _browser = _find_youtube_window(required=True)
    assert hwnd is not None
    _focus(hwnd)
    before = _probe_state(hwnd, include_ui=True, task_status="controlling")
    if not _is_playback_url(before.get("url")):
        raise ToolError("YOUTUBE_PLAYER_NOT_ACTIVE: the verified YouTube tab is not on a watch, Shorts, or live player page.")
    old_video = before.get("video_id")
    old_title = before.get("title")
    if action == "play":
        after = _play_or_pause(hwnd, "playing", before)
    elif action == "pause":
        after = _play_or_pause(hwnd, "paused", before)
    elif action == "stop":
        paused = _play_or_pause(hwnd, "paused", before)
        after = _seek(hwnd, 0.0, paused)
        # YouTube has no native stop state: the verified semantic stop is
        # paused at the beginning. Preserve the real player status separately.
        after["stopped"] = after.get("playback_state") == "paused" and float(after.get("position_seconds") or 0) <= 4.0
        if not after["stopped"]:
            raise ToolError("STOP_UNVERIFIED: the player is not paused at the beginning.")
        after["verified_fields"] = sorted(set(list(after.get("verified_fields") or []) + ["stopped"]))
    elif action == "restart":
        at_start = _seek(hwnd, 0.0, before)
        after = _play_or_pause(hwnd, "playing", at_start)
    elif action in {"next", "previous"}:
        media = _media_command(action, None, str(before.get("title") or ""))
        if not media or media.get("command_succeeded") is not True:
            _press(["shift", "n" if action == "next" else "p"])
        after = _wait_state(hwnd, lambda state: bool(state.get("video_id") and state.get("video_id") != old_video) or (state.get("title") and state.get("title") != old_title), 9.0)
        if after.get("video_id") == old_video and after.get("title") == old_title:
            # Outside a playlist, "next" may be unavailable. Search context can
            # still choose the next real result without opening a new tab.
            stored = _stored_state()
            if action == "next" and stored.get("search_query"):
                return youtube_play({
                    "query": stored.get("search_query"), "channel": stored.get("requested_channel"),
                    "result_index": int(stored.get("result_index") or 1) + 1,
                    "playlist": stored.get("selection_kind") == "playlist",
                    "latest": stored.get("latest_filter_applied") is True,
                })
            raise ToolError(f"YOUTUBE_{action.upper()}_UNAVAILABLE: the active player did not change video.")
    elif action == "another":
        stored = _stored_state()
        if not stored.get("search_query"):
            # With no search context, YouTube's own next recommendation is the
            # only semantic related-result operation available.
            return youtube_control({"action": "next"})
        return youtube_play({
            "query": stored.get("search_query"), "channel": stored.get("requested_channel"),
            "result_index": int(stored.get("result_index") or 1) + 1,
            "playlist": stored.get("selection_kind") == "playlist",
            "latest": stored.get("latest_filter_applied") is True,
        })
    elif action in {"forward", "backward"}:
        amount = float(args.get("seconds") or 10)
        if amount <= 0 or amount > 3600:
            raise ToolError("Relative seek seconds must be between 0 and 3600.")
        position = before.get("position_seconds")
        if not isinstance(position, (int, float)):
            raise ToolError("SEEK_UNSUPPORTED: the player did not expose its current position.")
        after = _seek(hwnd, float(position) + (amount if action == "forward" else -amount), before)
    elif action in {"seek", "middle", "seek_percent"}:
        duration = before.get("duration_seconds")
        if action == "middle":
            if not isinstance(duration, (int, float)) or duration <= 0:
                raise ToolError("SEEK_UNSUPPORTED: the player did not expose duration for a middle seek.")
            target = float(duration) / 2
        elif action == "seek_percent":
            percent = float(args.get("percent"))
            if percent < 0 or percent > 100 or not isinstance(duration, (int, float)) or duration <= 0:
                raise ToolError("seek_percent requires percent 0-100 and a player-reported duration.")
            target = float(duration) * percent / 100
        else:
            target = float(args.get("position_seconds"))
        after = _seek(hwnd, target, before)
    elif action in {"set_volume", "volume_up", "volume_down"}:
        if action == "set_volume":
            percent = int(round(float(args.get("volume_percent"))))
        else:
            current = before.get("volume_percent")
            if not isinstance(current, (int, float)):
                raise ToolError("PLAYER_VOLUME_UNSUPPORTED: current YouTube player volume is not verified.")
            step = int(round(float(args.get("amount") or 10)))
            percent = int(current) + (step if action == "volume_up" else -step)
        after = _set_volume(hwnd, percent)
    elif action in {"mute", "unmute", "toggle_mute"}:
        desired = None if action == "toggle_mute" else action == "mute"
        if desired is not None and before.get("muted") == desired:
            after = before
        else:
            clicked = _click_player_control(
                hwnd,
                lambda _element, name: (before.get("muted") is True and name.startswith("unmute"))
                or (before.get("muted") is False and name.startswith("mute")),
            )
            if not clicked:
                if not isinstance(before.get("muted"), bool):
                    raise ToolError("PLAYER_MUTE_UNSUPPORTED: mute state is not accessible, so a toggle would be unverified.")
                _press(["m"])
            expected = (not bool(before.get("muted"))) if desired is None else desired
            after = _wait_state(hwnd, lambda state: state.get("muted") == expected, 4.0, include_ui=True)
            if after.get("muted") != expected:
                raise ToolError("PLAYER_MUTE_UNVERIFIED: the YouTube control did not report the requested mute state.")
    elif action in {"fullscreen", "enter_fullscreen", "exit_fullscreen"}:
        desired = (not bool(before.get("fullscreen"))) if action == "fullscreen" else action == "enter_fullscreen"
        if before.get("fullscreen") == desired:
            after = before
        else:
            expected_name = "full screen" if desired else "exit full screen"
            clicked = _click_player_control(hwnd, lambda _element, name: name.startswith(expected_name))
            if not clicked:
                if not isinstance(before.get("fullscreen"), bool):
                    raise ToolError("FULLSCREEN_UNSUPPORTED: the active player does not expose fullscreen state.")
                _press(["f"])
            after = _wait_state(hwnd, lambda state: state.get("fullscreen") == desired, 5.0, include_ui=True)
            if after.get("fullscreen") != desired:
                raise ToolError("FULLSCREEN_UNVERIFIED: the player did not report the requested fullscreen state.")
    elif action in {"captions", "captions_on", "captions_off"}:
        desired = (not bool(before.get("captions_enabled"))) if action == "captions" else action == "captions_on"
        if before.get("captions_enabled") == desired:
            after = before
        else:
            clicked = _click_player_control(hwnd, lambda _element, name: "subtitles" in name or "closed captions" in name)
            if not clicked:
                if not isinstance(before.get("captions_enabled"), bool):
                    raise ToolError("CAPTIONS_UNSUPPORTED: captions are unavailable or their state is not accessible for this video.")
                _press(["c"])
            after = _wait_state(hwnd, lambda state: state.get("captions_enabled") == desired, 4.0, include_ui=True)
            if after.get("captions_enabled") != desired:
                raise ToolError("CAPTIONS_UNVERIFIED: captions may be unavailable for this video; the player state did not change.")
    else:  # set_speed
        after = _set_speed(hwnd, float(args.get("rate")))
    after["task_status"] = "controlled"
    after["verified"] = True
    after["result"] = f"Verified YouTube {action}: {after.get('title') or 'active video'} — state={after.get('playback_state')} at {after.get('position_seconds')}s."
    return _save_state(after)


__all__ = [
    "youtube_play", "youtube_control", "youtube_state", "youtube_cancel",
    "_result_candidates", "_video_id", "_playlist_id", "_is_playback_url",
]
