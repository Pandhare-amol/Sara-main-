"""Universal Windows application discovery, launch, and graceful close.

Known apps still take the fast path. Unknown names are resolved from PATH,
App Paths, installed-program registry entries, Start-menu shortcuts, and UWP
Start apps. As a final human-style fallback MYRAA uses Windows Search. Closing
targets real visible windows/processes instead of rejecting names that are not
in a hard-coded allow-list.
"""

from __future__ import annotations

import configparser
import os
import platform
import re
import shlex
import shutil
import json
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

from .registry import ToolError, register


APP_COMMANDS: Dict[str, Dict[str, str]] = {
    "notepad": {"exe": "notepad.exe", "image": "notepad.exe", "label": "Notepad"},
    "chrome": {"exe": "chrome.exe", "image": "chrome.exe", "label": "Google Chrome"},
    "edge": {"exe": "msedge.exe", "image": "msedge.exe", "label": "Microsoft Edge"},
    "vscode": {"exe": "code.cmd", "image": "Code.exe", "label": "Visual Studio Code"},
    "calculator": {"shell": "calc", "image": "CalculatorApp.exe", "label": "Calculator"},
    "calc": {"shell": "calc", "image": "CalculatorApp.exe", "label": "Calculator"},
    "file explorer": {"shell": "explorer", "image": "explorer.exe", "label": "File Explorer"},
    "explorer": {"shell": "explorer", "image": "explorer.exe", "label": "File Explorer"},
    "task manager": {"shell": "taskmgr", "image": "Taskmgr.exe", "label": "Task Manager"},
    "taskmanager": {"shell": "taskmgr", "image": "Taskmgr.exe", "label": "Task Manager"},
    "settings": {"uwp": "ms-settings:", "image": "SystemSettings.exe", "label": "Settings"},
    "command prompt": {"exe": "cmd.exe", "image": "cmd.exe", "label": "Command Prompt"},
    "cmd": {"exe": "cmd.exe", "image": "cmd.exe", "label": "Command Prompt"},
    "powershell": {"exe": "powershell.exe", "image": "powershell.exe", "label": "PowerShell"},
    "paint": {"shell": "mspaint", "image": "mspaint.exe", "label": "Paint"},
    "snipping tool": {"uwp": "ms-screenclip:", "image": "ScreenClippingHost.exe", "label": "Snipping Tool"},
}

# Sara OS ships these commands. Keeping a distinct map prevents Linux from
# ever trying a same-named Windows executable or UWP URI.
LINUX_APP_COMMANDS: Dict[str, Dict[str, str]] = {
    "browser": {"exe": "chromium", "image": "chromium", "label": "Chromium"},
    "chrome": {"exe": "chromium", "image": "chromium", "label": "Chromium"},
    "chromium": {"exe": "chromium", "image": "chromium", "label": "Chromium"},
    "files": {"exe": "thunar", "image": "thunar", "label": "Files"},
    "file manager": {"exe": "thunar", "image": "thunar", "label": "Files"},
    "file explorer": {"exe": "thunar", "image": "thunar", "label": "Files"},
    "terminal": {"exe": "xfce4-terminal", "image": "xfce4-terminal", "label": "Terminal"},
    "command prompt": {"exe": "xfce4-terminal", "image": "xfce4-terminal", "label": "Terminal"},
    "text editor": {"exe": "mousepad", "image": "mousepad", "label": "Text Editor"},
    "notepad": {"exe": "mousepad", "image": "mousepad", "label": "Text Editor"},
    "code editor": {"exe": "geany", "image": "geany", "label": "Geany"},
    "geany": {"exe": "geany", "image": "geany", "label": "Geany"},
    "calculator": {"exe": "galculator", "image": "galculator", "label": "Calculator"},
    "calc": {"exe": "galculator", "image": "galculator", "label": "Calculator"},
    "settings": {"exe": "xfce4-settings-manager", "image": "xfce4-settings-manager", "label": "Settings"},
    "task manager": {"exe": "xfce4-taskmanager", "image": "xfce4-taskmanager", "label": "Task Manager"},
    "office": {"exe": "libreoffice", "image": "libreoffice", "label": "LibreOffice"},
    "libreoffice": {"exe": "libreoffice", "image": "libreoffice", "label": "LibreOffice"},
    "writer": {"exe": "lowriter", "image": "libreoffice-writer", "label": "LibreOffice Writer"},
    "word processor": {"exe": "lowriter", "image": "libreoffice-writer", "label": "LibreOffice Writer"},
    "spreadsheet": {"exe": "localc", "image": "libreoffice-calc", "label": "LibreOffice Calc"},
    "excel": {"exe": "localc", "image": "libreoffice-calc", "label": "LibreOffice Calc"},
    "presentation": {"exe": "loimpress", "image": "libreoffice-impress", "label": "LibreOffice Impress"},
    "powerpoint": {"exe": "loimpress", "image": "libreoffice-impress", "label": "LibreOffice Impress"},
    "media player": {"exe": "vlc", "image": "vlc", "label": "VLC Media Player"},
    "vlc": {"exe": "vlc", "image": "vlc", "label": "VLC Media Player"},
    "pdf viewer": {"exe": "evince", "image": "evince", "label": "Document Viewer"},
    "document viewer": {"exe": "evince", "image": "evince", "label": "Document Viewer"},
    "image viewer": {"exe": "ristretto", "image": "ristretto", "label": "Image Viewer"},
    "photos": {"exe": "ristretto", "image": "ristretto", "label": "Image Viewer"},
    "archive manager": {"exe": "file-roller", "image": "file-roller", "label": "Archive Manager"},
    "screenshot": {"exe": "xfce4-screenshooter", "image": "xfce4-screenshooter", "label": "Screenshot"},
    "audio settings": {"exe": "pavucontrol", "image": "pavucontrol", "label": "Audio Settings"},
    "bluetooth": {"exe": "blueman-manager", "image": "blueman-manager", "label": "Bluetooth Manager"},
    "disk utility": {"exe": "gnome-disks", "image": "gnome-disks", "label": "Disks"},
    "scanner": {"exe": "simple-scan", "image": "simple-scan", "label": "Document Scanner"},
}

ALIASES = {
    "code": "vscode", "visual studio code": "vscode", "vs code": "vscode",
    "google chrome": "chrome", "microsoft edge": "edge", "settings app": "settings",
    "windows explorer": "file explorer", "explorer": "file explorer",
    "libreoffice writer": "writer", "microsoft word": "writer", "word": "writer",
    "libreoffice calc": "spreadsheet", "libreoffice spreadsheet": "spreadsheet",
    "libreoffice impress": "presentation", "slide editor": "presentation",
    "video player": "media player", "movie player": "media player",
    "picture viewer": "image viewer", "photo viewer": "image viewer",
    "pdf reader": "pdf viewer", "sound settings": "audio settings",
}


def _normalize_name(value: Any) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", str(value).casefold()))


def _compact(value: Any) -> str:
    return _normalize_name(value).replace(" ", "")


def _resolve_known_app(key: str) -> Optional[Dict[str, str]]:
    norm = _normalize_name(key)
    norm = ALIASES.get(norm, norm)
    if platform.system() == "Linux":
        return LINUX_APP_COMMANDS.get(norm)
    return APP_COMMANDS.get(norm)


def _candidate_score(query: str, label: str) -> int:
    q, candidate = _normalize_name(query), _normalize_name(label)
    if not q or not candidate:
        return 0
    if q == candidate:
        return 1_000
    if _compact(q) == _compact(candidate):
        return 980
    query_tokens, candidate_tokens = set(q.split()), set(candidate.split())
    if query_tokens and query_tokens.issubset(candidate_tokens):
        return 700 - abs(len(candidate) - len(q))
    if candidate_tokens and candidate_tokens.issubset(query_tokens):
        return 660 - abs(len(candidate) - len(q))
    return 0


def _start_menu_dirs() -> Iterable[tuple[Path, bool]]:
    """(directory, recursive). Desktops are scanned top-level only: they often
    hold project folders with hundreds of thousands of files."""
    program_data = os.environ.get("PROGRAMDATA")
    app_data = os.environ.get("APPDATA")
    user_profile = os.environ.get("USERPROFILE")
    if program_data:
        yield Path(program_data) / "Microsoft" / "Windows" / "Start Menu", True
    if app_data:
        yield Path(app_data) / "Microsoft" / "Windows" / "Start Menu", True
    if user_profile:
        yield Path(user_profile) / "Desktop", False
        yield Path(user_profile) / "OneDrive" / "Desktop", False
    public = os.environ.get("PUBLIC")
    if public:
        yield Path(public) / "Desktop", False


def _shortcut_candidates() -> Iterable[Dict[str, str]]:
    for directory, recursive in _start_menu_dirs():
        if not directory.exists():
            continue
        try:
            for path in (directory.rglob("*") if recursive else directory.iterdir()):
                if path.suffix.casefold() in {".lnk", ".url"} and path.is_file():
                    yield {"label": path.stem, "path": str(path), "method": "start_menu"}
        except (OSError, PermissionError):
            continue


def _clean_display_icon(value: str) -> Optional[Path]:
    raw = str(value or "").strip().strip('"')
    raw = re.sub(r",-?\d+$", "", raw).strip().strip('"')
    return Path(os.path.expandvars(raw)) if raw else None


def _registry_candidates(query: str) -> Iterable[Dict[str, str]]:
    if platform.system() != "Windows":
        return
    try:
        import winreg
    except ImportError:
        return

    def value(key, name: Optional[str]) -> str:
        try:
            return str(winreg.QueryValueEx(key, name)[0] or "")
        except OSError:
            return ""

    for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            parent = winreg.OpenKey(root, r"Software\Microsoft\Windows\CurrentVersion\App Paths")
        except OSError:
            continue
        with parent:
            index = 0
            while True:
                try:
                    child_name = winreg.EnumKey(parent, index)
                    index += 1
                except OSError:
                    break
                try:
                    with winreg.OpenKey(parent, child_name) as child:
                        executable = Path(os.path.expandvars(value(child, None).strip('"')))
                    if executable.is_file():
                        yield {"label": Path(child_name).stem, "path": str(executable), "method": "app_paths"}
                except OSError:
                    continue

    uninstall_paths = (
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
        r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    )
    for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for registry_path in uninstall_paths:
            try:
                parent = winreg.OpenKey(root, registry_path)
            except OSError:
                continue
            with parent:
                index = 0
                while True:
                    try:
                        child_name = winreg.EnumKey(parent, index)
                        index += 1
                    except OSError:
                        break
                    try:
                        with winreg.OpenKey(parent, child_name) as child:
                            label = value(child, "DisplayName")
                            icon = _clean_display_icon(value(child, "DisplayIcon"))
                            install_raw = value(child, "InstallLocation")
                            install = Path(os.path.expandvars(install_raw)) if install_raw else None
                    except OSError:
                        continue
                    if not label or _candidate_score(query, label) <= 0:
                        continue
                    executable: Optional[Path] = None
                    if icon and icon.is_file() and icon.name.casefold() not in {"uninstall.exe", "unins000.exe"}:
                        executable = icon
                    search_dir = install if install and install.is_dir() else (icon.parent if icon else None)
                    if executable is None and search_dir and search_dir.is_dir():
                        desired = _compact(query)
                        try:
                            exact = [path for path in search_dir.glob("*.exe") if _compact(path.stem) == desired]
                            executable = exact[0] if exact else None
                        except OSError:
                            pass
                    if executable and executable.is_file():
                        yield {"label": label, "path": str(executable), "method": "installed_apps"}


def _uwp_candidates() -> Iterable[Dict[str, str]]:
    if platform.system() != "Windows":
        return
    try:
        command = [
            "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
            "Get-StartApps | ForEach-Object { $_.Name + [char]9 + $_.AppID }",
        ]
        output = subprocess.run(
            command, capture_output=True, text=True, timeout=25, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
        for line in output.splitlines():
            if "\t" in line:
                label, app_id = line.split("\t", 1)
                if label.strip() and app_id.strip():
                    yield {"label": label.strip(), "app_id": app_id.strip(), "method": "windows_apps"}
    except Exception:
        return


def _linux_desktop_dirs() -> list[Path]:
    """Freedesktop application roots in precedence order."""
    home = Path.home()
    data_home = Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share"))
    data_dirs = [Path(item) for item in os.environ.get("XDG_DATA_DIRS", "/usr/local/share:/usr/share").split(":") if item]
    roots = [data_home / "applications"]
    roots.extend(root / "applications" for root in data_dirs)
    roots.extend([
        home / ".local/share/flatpak/exports/share/applications",
        Path("/var/lib/flatpak/exports/share/applications"),
        Path("/var/lib/snapd/desktop/applications"),
    ])
    seen: set[str] = set()
    ordered: list[Path] = []
    for root in roots:
        key = str(root)
        if key not in seen:
            seen.add(key)
            ordered.append(root)
    return ordered


def _desktop_bool(section: configparser.SectionProxy, key: str) -> bool:
    return str(section.get(key, "false")).strip().casefold() in {"1", "true", "yes"}


def _desktop_executable(exec_line: str) -> str:
    """Extract only the executable name for matching; never execute this text."""
    cleaned = re.sub(r"%[fFuUdDnNickvm]", "", exec_line).strip()
    try:
        words = shlex.split(cleaned)
    except ValueError:
        return ""
    if not words:
        return ""
    if words[0] == "env":
        words = [word for word in words[1:] if "=" not in word]
    return Path(words[0]).name if words else ""


def _linux_desktop_candidates() -> Iterable[Dict[str, str]]:
    """Enumerate trusted installed .desktop launchers without running Exec."""
    claimed_ids: set[str] = set()
    scanned = 0
    for root in _linux_desktop_dirs():
        if not root.is_dir():
            continue
        try:
            paths = root.rglob("*.desktop")
            for desktop_file in paths:
                scanned += 1
                if scanned > 2_500:
                    return
                try:
                    relative = desktop_file.relative_to(root).with_suffix("")
                    desktop_id = "-".join(relative.parts)
                except ValueError:
                    desktop_id = desktop_file.stem
                if desktop_id in claimed_ids:
                    continue
                claimed_ids.add(desktop_id)
                parser = configparser.ConfigParser(interpolation=None, strict=False)
                parser.optionxform = str
                try:
                    parser.read(desktop_file, encoding="utf-8")
                    entry = parser["Desktop Entry"]
                except (OSError, UnicodeError, KeyError, configparser.Error):
                    continue
                if entry.get("Type", "Application") != "Application":
                    continue
                if _desktop_bool(entry, "Hidden") or _desktop_bool(entry, "NoDisplay"):
                    continue
                current_desktops = {
                    item.casefold()
                    for item in re.split(r"[:;]", os.environ.get("XDG_CURRENT_DESKTOP", ""))
                    if item
                }
                only_show = {item.casefold() for item in entry.get("OnlyShowIn", "").split(";") if item}
                not_show = {item.casefold() for item in entry.get("NotShowIn", "").split(";") if item}
                if only_show and current_desktops and only_show.isdisjoint(current_desktops):
                    continue
                if not_show.intersection(current_desktops):
                    continue
                label = entry.get("Name", "").strip()
                exec_line = entry.get("Exec", "").strip()
                if not label or not exec_line:
                    continue
                try_exec = entry.get("TryExec", "").strip()
                if try_exec and not (shutil.which(try_exec) or Path(try_exec).exists()):
                    continue
                image = entry.get("StartupWMClass", "").strip() or _desktop_executable(exec_line)
                categories = ",".join(item for item in entry.get("Categories", "").split(";") if item)[:300]
                yield {
                    "label": label[:160],
                    "desktop_id": desktop_id,
                    "path": str(desktop_file),
                    "image": image[:160],
                    "categories": categories,
                    "method": "desktop_entry",
                }
        except OSError:
            continue


# ---- installed-app index ---------------------------------------------------
# Scanning Start-menu shortcuts and Store apps takes seconds (PowerShell's
# Get-StartApps alone is 1-6 s cold), far too slow to do on every "open X".
# The index is built in the background when the agent starts, cached on disk
# for the next start, and refreshed when it is older than 15 minutes.
_INDEX_LOCK = threading.Lock()
_INDEX: Dict[str, Any] = {"built": 0.0, "items": [], "building": False}
_INDEX_READY = threading.Event()
_INDEX_MAX_AGE = 15 * 60


def _index_cache_path() -> Optional[Path]:
    if platform.system() == "Linux":
        base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
        return base / "sara" / "app-index.json"
    base = os.environ.get("LOCALAPPDATA")
    return Path(base) / "MYRAA" / "app-index.json" if base else None


def _build_index() -> None:
    try:
        if platform.system() == "Linux":
            items = list(_linux_desktop_candidates())
        else:
            items = list(_shortcut_candidates()) + list(_uwp_candidates() or [])
        with _INDEX_LOCK:
            _INDEX["items"] = items
            _INDEX["built"] = time.time()
        cache = _index_cache_path()
        if cache:
            try:
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_text(json.dumps({"built": _INDEX["built"], "items": items}), encoding="utf-8")
            except OSError:
                pass
    finally:
        with _INDEX_LOCK:
            _INDEX["building"] = False
        _INDEX_READY.set()


def _refresh_index_async() -> None:
    with _INDEX_LOCK:
        if _INDEX["building"]:
            return
        _INDEX["building"] = True
    threading.Thread(target=_build_index, name="myraa-app-index", daemon=True).start()


def _load_index_cache() -> None:
    cache = _index_cache_path()
    try:
        if cache and cache.exists():
            data = json.loads(cache.read_text(encoding="utf-8"))
            if isinstance(data.get("items"), list):
                with _INDEX_LOCK:
                    _INDEX["items"] = [item for item in data["items"] if isinstance(item, dict) and item.get("label")]
                    _INDEX["built"] = float(data.get("built") or 0)
                _INDEX_READY.set()
    except (OSError, ValueError):
        pass


def _indexed_candidates(wait: float = 6.0) -> list[Dict[str, str]]:
    if not _INDEX_READY.is_set():
        _refresh_index_async()
        _INDEX_READY.wait(wait)
    elif time.time() - _INDEX["built"] > _INDEX_MAX_AGE:
        _refresh_index_async()
    with _INDEX_LOCK:
        return list(_INDEX["items"])


def warm_app_index() -> None:
    """Load the cached app catalogue and refresh it without blocking startup."""
    if platform.system() not in {"Windows", "Linux"}:
        return
    _load_index_cache()
    _refresh_index_async()


def _discover_application(name: str) -> Optional[Dict[str, str]]:
    raw = str(name).strip()
    direct = shutil.which(raw) or (shutil.which(f"{raw}.exe") if platform.system() == "Windows" else None)
    candidates: list[Dict[str, str]] = []
    if direct:
        candidates.append({"label": Path(direct).stem, "path": direct, "method": "path"})
    if platform.system() == "Windows":
        candidates.extend(_registry_candidates(raw) or [])
        candidates.extend(_indexed_candidates())
    elif platform.system() == "Linux":
        candidates.extend(_indexed_candidates(wait=2.0))
    ranked = sorted(
        ((candidate, _candidate_score(raw, candidate["label"])) for candidate in candidates),
        key=lambda item: item[1], reverse=True,
    )
    return ranked[0][0] if ranked and ranked[0][1] >= 600 else None


def _launch_known(spec: Dict[str, str]) -> None:
    try:
        if "exe" in spec:
            executable = shutil.which(spec["exe"])
            if not executable:
                discovered = _discover_application(spec["label"])
                executable = discovered.get("path") if discovered else None
            if not executable:
                raise ToolError(f"The operating system could not find the installed executable for {spec['label']}.")
            popen_args: Dict[str, Any] = {"shell": False, "close_fds": True}
            if platform.system() == "Windows":
                popen_args["creationflags"] = (
                    getattr(subprocess, "DETACHED_PROCESS", 0)
                    | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                )
            else:
                popen_args["start_new_session"] = True
            subprocess.Popen([executable], **popen_args)
        elif "shell" in spec:
            subprocess.Popen(["cmd.exe", "/c", "start", "", spec["shell"]], close_fds=True)
        elif "uwp" in spec:
            os.startfile(spec["uwp"])
        else:
            raise ToolError(f"App spec for {spec.get('label')} is incomplete.")
    except Exception as error:
        raise ToolError(f"Could not launch {spec.get('label')}: {error}") from error


def _launch_discovered(candidate: Dict[str, str]) -> None:
    try:
        if candidate.get("app_id"):
            subprocess.Popen(["explorer.exe", f"shell:AppsFolder\\{candidate['app_id']}"])
        elif platform.system() == "Windows":
            os.startfile(candidate["path"])
        elif candidate.get("desktop_id"):
            launcher = shutil.which("gtk-launch")
            if not launcher:
                raise ToolError("gtk-launch is unavailable; the desktop application cannot be started semantically.")
            subprocess.Popen(
                [launcher, candidate["desktop_id"]], shell=False, close_fds=True,
                start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        else:
            subprocess.Popen([candidate["path"]], shell=False, close_fds=True, start_new_session=True)
    except ToolError:
        raise
    except Exception as error:
        raise ToolError(f"Could not launch {candidate.get('label')}: {error}") from error


def _launch_via_windows_search(name: str) -> None:
    if platform.system() != "Windows":
        raise ToolError(f"No installed application matching '{name}' was found on this system.")
    try:
        import pyautogui

        pyautogui.FAILSAFE = True
        pyautogui.press("win")
        time.sleep(0.25)
        pyautogui.write(name, interval=0.025)
        time.sleep(0.9)
        pyautogui.press("enter")
    except Exception as error:
        raise ToolError(
            f"Windows Search could not open '{name}'. The installed-app scan also found no match: {error}"
        ) from error


def _matching_linux_windows(name: str) -> list[Dict[str, Any]]:
    """Return X11 windows from wmctrl without reading their contents."""
    try:
        output = subprocess.run(
            ["wmctrl", "-lpGx"], capture_output=True, text=True, timeout=3, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    query = _normalize_name(name)
    known = _resolve_known_app(name)
    expected = _compact(known.get("image", "")) if known else _compact(query)
    matches: list[Dict[str, Any]] = []
    for line in output.stdout.splitlines():
        parts = line.split(None, 8)
        if len(parts) < 9:
            continue
        window_id, _desktop, pid, _x, _y, _w, _h, window_class, title = parts
        title_norm = _normalize_name(title)
        class_norm = _compact(window_class)
        score = 0
        if query and query == title_norm:
            score = 1_000
        elif query and set(query.split()).issubset(set(title_norm.split())):
            score = 800
        if expected and expected in class_norm:
            score = max(score, 950)
        if score:
            matches.append({
                "hwnd": window_id, "pid": int(pid) if pid.isdigit() else 0,
                "title": title, "process": window_class, "score": score,
            })
    return sorted(matches, key=lambda item: item["score"], reverse=True)


def _matching_windows(name: str) -> list[Dict[str, Any]]:
    if platform.system() == "Linux":
        return _matching_linux_windows(name)
    if platform.system() != "Windows":
        return []
    try:
        import psutil
        import win32gui
        import win32process
    except ImportError:
        return []
    query = _normalize_name(name)
    known = _resolve_known_app(name)
    expected_image = _compact(Path(known["image"]).stem) if known and known.get("image") else ""
    matches: list[Dict[str, Any]] = []

    def callback(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return True
        title = win32gui.GetWindowText(hwnd).strip()
        if not title:
            return True
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            process_name = psutil.Process(pid).name()
        except Exception:
            pid, process_name = 0, ""
        title_norm = _normalize_name(title)
        process_norm = _compact(Path(process_name).stem)
        score = 0
        if query == title_norm:
            score = 1_000
        elif set(query.split()).issubset(set(title_norm.split())):
            score = 800
        if process_norm == _compact(query) or (expected_image and process_norm == expected_image):
            score = max(score, 950)
        if score:
            matches.append({"hwnd": int(hwnd), "pid": int(pid), "title": title, "process": process_name, "score": score})
        return True

    try:
        win32gui.EnumWindows(callback, None)
    except Exception:
        return []
    return sorted(matches, key=lambda item: item["score"], reverse=True)


def _close_windows_with_keyboard(matches: list[Dict[str, Any]]) -> int:
    if platform.system() == "Linux":
        closed = 0
        for match in matches[:8]:
            result = subprocess.run(
                ["wmctrl", "-ic", str(match["hwnd"])],
                capture_output=True, text=True, timeout=3, check=False,
            )
            if result.returncode == 0:
                closed += 1
        return closed

    import win32gui
    from .tools_windows import _focus
    import pyautogui

    pyautogui.FAILSAFE = True
    closed = 0
    for match in matches[:8]:
        hwnd = match["hwnd"]
        if not win32gui.IsWindow(hwnd) or not win32gui.IsWindowVisible(hwnd):
            continue
        try:
            _focus(hwnd)
            time.sleep(0.12)
            pyautogui.hotkey("alt", "f4")
            closed += 1
            time.sleep(0.18)
        except Exception:
            continue
    return closed


@register("listApplications")
def list_applications(args: Dict[str, Any]) -> Dict[str, Any]:
    """List installed GUI applications from OS-owned catalogues."""
    if args.get("refresh"):
        _INDEX_READY.clear()
        _refresh_index_async()
    items = _indexed_candidates(wait=4.0)
    query = str(args.get("query") or "").strip()
    limit = max(1, min(200, int(args.get("limit", 80))))
    ranked: list[tuple[int, Dict[str, str]]] = []
    for item in items:
        label = str(item.get("label") or "").strip()
        if not label:
            continue
        score = _candidate_score(query, label) if query else 1
        if query and score <= 0:
            categories = str(item.get("categories") or "")
            image = str(item.get("image") or "")
            score = max(_candidate_score(query, categories.replace(",", " ")), _candidate_score(query, image))
        if score > 0:
            ranked.append((score, item))
    ranked.sort(key=lambda pair: (-pair[0], pair[1].get("label", "").casefold()))
    seen: set[str] = set()
    applications: list[Dict[str, str]] = []
    for _score, item in ranked:
        label_key = item["label"].casefold()
        if label_key in seen:
            continue
        seen.add(label_key)
        applications.append({
            "name": item["label"],
            "id": item.get("desktop_id") or item.get("app_id") or "",
            "categories": item.get("categories", ""),
            "launcher": item.get("method", "installed_app"),
        })
        if len(applications) >= limit:
            break
    suffix = f" matching {query!r}" if query else ""
    return {
        "result": f"Found {len(applications)} installed application(s){suffix}.",
        "applications": applications,
        "query": query or None,
        "platform": platform.system(),
        "catalogue_age_seconds": max(0, int(time.time() - float(_INDEX.get("built") or time.time()))),
    }


@register("openApplication")
def open_application(args: Dict[str, Any]) -> Dict[str, Any]:
    name = str(args.get("name") or args.get("application") or "").strip()
    if not name:
        raise ToolError("Parameter 'name' (application name) is required.")
    known = _resolve_known_app(name)
    if known:
        _launch_known(known)
        message = f"Launch requested for {known['label']}." if platform.system() == "Linux" else f"{known['label']} opened."
        return {"result": message, "application": known["label"], "method": "known_app"}
    discovered = _discover_application(name)
    if not discovered and _INDEX["built"] and time.time() - _INDEX["built"] > 120:
        # Maybe installed since the index was built: rebuild once, then retry.
        _INDEX_READY.clear()
        _refresh_index_async()
        _INDEX_READY.wait(12)
        discovered = _discover_application(name)
    if discovered:
        _launch_discovered(discovered)
        return {
            "result": f"Launch requested for installed application {discovered['label']}." if platform.system() == "Linux" else f"Opened installed application {discovered['label']}.",
            "application": discovered["label"], "method": discovered["method"],
        }
    _launch_via_windows_search(name)
    return {
        "result": f"Asked Windows Search to open '{name}' using keyboard control.",
        "application": name, "method": "windows_search_keyboard",
    }


@register("closeApplication")
def close_application(args: Dict[str, Any]) -> Dict[str, Any]:
    name = str(args.get("name") or args.get("application") or "").strip()
    force = bool(args.get("force", False))
    if not name:
        raise ToolError("Parameter 'name' (application name) is required.")
    matches = _matching_windows(name)
    if matches:
        closed = _close_windows_with_keyboard(matches)
        if closed:
            linux = platform.system() == "Linux"
            return {
                "result": f"Closed {closed} visible '{name}' window(s) through the window manager." if linux else f"Closed {closed} visible '{name}' window(s) with Alt+F4.",
                "application": name, "windows_closed": closed,
                "method": "wmctrl_close" if linux else "keyboard_alt_f4",
            }
    if force:
        try:
            import psutil

            query = _compact(name)
            known = _resolve_known_app(name)
            expected = _compact(Path(known["image"]).stem) if known and known.get("image") else query
            terminated = 0
            for process in psutil.process_iter(["name"]):
                if _compact(Path(process.info.get("name") or "").stem) in {query, expected}:
                    process.terminate()
                    terminated += 1
            if terminated:
                return {
                    "result": f"Force-closed {terminated} '{name}' process(es).",
                    "application": name, "processes_closed": terminated, "method": "process_terminate",
                }
        except Exception as error:
            raise ToolError(f"Could not force-close '{name}': {error}") from error
    raise ToolError(
        f"No running visible window matching '{name}' was found. "
        "The name was searched across all windows and processes; it is not limited by a supported-app list."
    )


__all__ = [
    "warm_app_index", "list_applications",
    "open_application", "close_application", "APP_COMMANDS", "LINUX_APP_COMMANDS", "_candidate_score",
    "_discover_application", "_matching_windows", "_linux_desktop_candidates",
]
