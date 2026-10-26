"""
Window management: minimize / maximize / close the active window or switch apps.

Windows uses Win32 APIs. Sara OS/Linux uses semantic X11 window IDs through
xdotool/wmctrl, which are installed in the image. Unsupported platforms fail
cleanly instead of claiming a state change.
"""

from __future__ import annotations

import platform
import subprocess
import time
from typing import Any, Dict, Optional

from .registry import ToolError, register

SW_MINIMIZE = 6
SW_MAXIMIZE = 3
SW_RESTORE = 9
SW_HIDE = 0


def _run_linux(command: list[str], *, timeout: float = 3.0) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command, capture_output=True, text=True, timeout=timeout, check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ToolError(f"Linux window control is unavailable: {error}") from error


def _get_foreground_window():
    if platform.system() == "Linux":
        result = _run_linux(["xdotool", "getactivewindow"])
        value = result.stdout.strip()
        return value if result.returncode == 0 and value else None
    if platform.system() != "Windows":
        return None
    try:
        import win32gui

        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        return hwnd
    except Exception:
        return None


def _window_title(hwnd) -> str:
    if platform.system() == "Linux":
        result = _run_linux(["xdotool", "getwindowname", str(hwnd)])
        return result.stdout.strip() if result.returncode == 0 else ""
    try:
        import win32gui

        return win32gui.GetWindowText(hwnd)
    except Exception:
        return ""


def _show_window(hwnd, cmd) -> None:
    if platform.system() == "Linux":
        window_id = str(hwnd)
        if cmd == SW_MINIMIZE:
            result = _run_linux(["xdotool", "windowminimize", window_id])
        elif cmd == SW_MAXIMIZE:
            result = _run_linux(["wmctrl", "-ir", window_id, "-b", "add,maximized_vert,maximized_horz"])
        elif cmd == SW_RESTORE:
            result = _run_linux(["wmctrl", "-ir", window_id, "-b", "remove,maximized_vert,maximized_horz"])
            if result.returncode == 0:
                result = _run_linux(["wmctrl", "-ia", window_id])
        else:
            raise ToolError(f"Window state command {cmd} is unsupported on Sara OS.")
        if result.returncode != 0:
            raise ToolError(result.stderr.strip() or "The window manager rejected the requested state change.")
        return
    try:
        import win32gui

        win32gui.ShowWindow(hwnd, cmd)
    except Exception as error:  # noqa: BLE001
        raise ToolError(f"Could not change window state: {error}") from error


def _close_window_hwnd(hwnd) -> None:
    if platform.system() == "Linux":
        result = _run_linux(["wmctrl", "-ic", str(hwnd)])
        if result.returncode != 0:
            raise ToolError(result.stderr.strip() or "The window manager refused to close that window.")
        return
    try:
        import win32con
        import win32gui

        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
    except Exception as error:  # noqa: BLE001
        raise ToolError(f"Could not close window: {error}") from error


def _find_window_by_title(query: str):
    """Return the first visible window whose title contains query."""
    if platform.system() == "Linux":
        result = _run_linux(["wmctrl", "-l"])
        if result.returncode != 0:
            return None
        needle = query.casefold()
        for line in result.stdout.splitlines():
            parts = line.split(None, 3)
            if len(parts) == 4 and needle in parts[3].casefold():
                return parts[0]
        return None
    if platform.system() != "Windows":
        return None
    try:
        import win32gui

        matches = []

        def cb(hwnd, _):
            if win32gui.IsWindowVisible(hwnd):
                title = win32gui.GetWindowText(hwnd)
                if title and query.lower() in title.lower():
                    matches.append(hwnd)
            return True

        win32gui.EnumWindows(cb, None)
        return matches[0] if matches else None
    except Exception:
        return None


def _focus(hwnd) -> None:
    """Bring a window to the foreground and verify it."""
    if platform.system() == "Linux":
        result = _run_linux(["wmctrl", "-ia", str(hwnd)])
        if result.returncode != 0:
            raise ToolError(result.stderr.strip() or "The window manager refused to focus that window.")
        time.sleep(0.08)
        active = _get_foreground_window()
        # wmctrl emits a hex ID while xdotool normally emits decimal. Compare
        # numerically when possible and otherwise retain a strict string check.
        try:
            matches = int(str(active), 0) == int(str(hwnd), 0)
        except (TypeError, ValueError):
            matches = str(active).casefold() == str(hwnd).casefold()
        if not matches:
            raise ToolError("Could not verify that the requested Linux window received focus.")
        return

    import ctypes
    import win32gui

    if win32gui.IsIconic(hwnd):
        _show_window(hwnd, SW_RESTORE)
        time.sleep(0.12)
    for _attempt in range(3):
        try:
            win32gui.SetForegroundWindow(hwnd)
        except Exception:
            pass
        time.sleep(0.06)
        if int(win32gui.GetForegroundWindow()) == int(hwnd):
            return
        VK_MENU, KEYEVENTF_KEYUP = 0x12, 0x0002
        ctypes.windll.user32.keybd_event(VK_MENU, 0, 0, 0)
        ctypes.windll.user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.05)
        try:
            win32gui.BringWindowToTop(hwnd)
        except Exception:
            pass
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass
    time.sleep(0.08)
    if int(win32gui.GetForegroundWindow()) != int(hwnd):
        raise ToolError("Could not focus window: Windows refused to switch the foreground window.")


def _resolve_target(args: Dict[str, Any]):
    """Pick the window to operate on: explicit title, or foreground window."""
    title: Optional[str] = args.get("title") or args.get("application")
    if title:
        hwnd = _find_window_by_title(str(title))
        if not hwnd:
            raise ToolError(f"No visible window with title containing '{title}'.")
        return hwnd, str(title)
    hwnd = _get_foreground_window()
    if not hwnd:
        raise ToolError("No active window found.")
    return hwnd, _window_title(hwnd)


@register("minimizeWindow")
def minimize_window(args: Dict[str, Any]) -> Dict[str, Any]:
    hwnd, title = _resolve_target(args)
    _show_window(hwnd, SW_MINIMIZE)
    return {"result": f"Minimized window: {title or 'active window'}."}


@register("maximizeWindow")
def maximize_window(args: Dict[str, Any]) -> Dict[str, Any]:
    hwnd, title = _resolve_target(args)
    _show_window(hwnd, SW_MAXIMIZE)
    return {"result": f"Maximized window: {title or 'active window'}."}


@register("closeWindow")
def close_window(args: Dict[str, Any]) -> Dict[str, Any]:
    hwnd, title = _resolve_target(args)
    _close_window_hwnd(hwnd)
    return {"result": f"Closed window: {title or 'active window'}."}


@register("switchApplication")
def switch_application(args: Dict[str, Any]) -> Dict[str, Any]:
    """Focus a window by title, or cycle windows (Alt+Tab) if no title given."""
    title = args.get("title") or args.get("application")
    if title:
        hwnd = _find_window_by_title(str(title))
        if not hwnd:
            raise ToolError(f"No visible window matching '{title}'.")
        _show_window(hwnd, SW_RESTORE)
        _focus(hwnd)
        return {"result": f"Switched to: {str(title)}."}

    try:
        import pyautogui

        pyautogui.hotkey("alt", "tab")
        return {"result": "Cycled to the next window."}
    except Exception:
        if platform.system() == "Windows":
            try:
                import win32gui

                order = []

                def cb(hwnd, _):
                    if win32gui.IsWindowVisible(hwnd) and win32gui.GetWindowText(hwnd):
                        order.append(hwnd)
                    return True

                win32gui.EnumWindows(cb, None)
                foreground = win32gui.GetForegroundWindow()
                if order:
                    index = order.index(foreground) if foreground in order else -1
                    nxt = order[(index + 1) % len(order)]
                    _focus(nxt)
                    return {"result": f"Switched to: {win32gui.GetWindowText(nxt)}."}
            except Exception:
                pass
        raise ToolError("Could not switch applications.")


__all__ = [
    "minimize_window",
    "maximize_window",
    "close_window",
    "switch_application",
]
