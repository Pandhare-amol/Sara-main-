"""
Per-user auto-start management for Sara on Windows and Linux desktops.

On Windows, manages a single registry entry under
    HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Myraa
which points directly at the packaged MYRAA executable. Source-development
builds fall back to start-myraa-silent.bat. HKCU is used (no admin rights
required) and the change is per-user.

Tools:
  - enableAutoStart   : write the Run key + ensure the .bat exists
  - disableAutoStart  : remove the Run key
  - getAutoStartStatus: report whether the entry exists + its target

On Linux, writes a per-user freedesktop XDG autostart entry (or a Hidden=true
override for the Sara OS system default). Other platforms degrade explicitly.
"""

from __future__ import annotations

import configparser
import os
import shutil
import sys
from pathlib import Path
from typing import Any, Dict

from .registry import ToolError, register

RUN_KEY_PATH = r"Software\\Microsoft\\Windows\\CurrentVersion\\Run"
VALUE_NAME = "Myraa"
SILENT_LAUNCHER = "start-myraa-silent.bat"


def _project_root() -> str:
    """Return the project root (parent of the desktop_agent package)."""
    # desktop_agent/tools_startup.py -> .. -> project root
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _launcher_path() -> str:
    return os.path.join(_project_root(), SILENT_LAUNCHER)


def _ensure_launcher_exists() -> str:
    """
    Make sure start-myraa-silent.bat exists in the project root.
    If missing, write a minimal silent launcher so auto-start never breaks.
    """
    path = _launcher_path()
    if os.path.isfile(path):
        return path
    # Best-effort creation of a silent launcher that starts both backends.
    py_candidates = [
        r"C:\\Users\\MSI\\AppData\\Local\\Programs\\Python\\Python311\\python.exe",
        "python",
        "python3",
    ]
    py = next((p for p in py_candidates if _which(p)), "python")
    body = "\n".join(
        [
            "@echo off",
            "chcp 65001 >nul",
            f'set "PROJECT_DIR={_project_root()}"',
            f'set "PYTHON_EXE={py}"',
            "cd /d \"%PROJECT_DIR%\"",
            (
                'start "" /B "%PYTHON_EXE%" -m uvicorn desktop_agent.main:app '
                '--host 127.0.0.1 --port 8765'
            ),
            "timeout /t 3 /nobreak >nul",
            "start \"\" /B npm run dev",
            "timeout /t 6 /nobreak >nul",
            'start "" "http://localhost:3000"',
            "",
        ]
    )
    try:
        with open(path, "w", encoding="utf-8", newline="\r\n") as fh:
            fh.write(body)
    except OSError as e:  # pragma: no cover - filesystem error
        raise ToolError(f"Could not create silent launcher: {e}") from e
    return path


def _startup_command() -> tuple[str, str]:
    """Return (registry command, display target) for this runtime.

    Electron supplies MYRAA_EXECUTABLE only in a packaged build. Using that
    path keeps auto-start independent of Node, npm, Python, project folders,
    and terminal windows.
    """
    packaged_executable = os.environ.get("MYRAA_EXECUTABLE", "").strip().strip('"')
    if packaged_executable and os.path.isfile(packaged_executable):
        return f'"{packaged_executable}"', packaged_executable
    launcher = _ensure_launcher_exists()
    return f'cmd /c "{launcher}"', launcher


def _which(cmd: str) -> bool:
    """True if a command resolves on PATH (very small shim, no shutil import)."""
    from shutil import which

    return which(cmd) is not None


def _is_windows() -> bool:
    return sys.platform.startswith("win") or os.name == "nt"


# --- Registry helpers --------------------------------------------------------

def _open_run_key():
    """Open HKCU Run key for read/write. Returns the handle (caller closes)."""
    if not _is_windows():
        raise ToolError("Auto-start is only supported on Windows.")
    import winreg  # type: ignore[import-not-found]

    return winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, RUN_KEY_PATH, 0, winreg.KEY_SET_VALUE | winreg.KEY_READ)


def _read_run_value() -> str | None:
    if not _is_windows():
        return None
    try:
        import winreg  # type: ignore[import-not-found]

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, RUN_KEY_PATH, 0, winreg.KEY_READ
        ) as key:
            value, _ = winreg.QueryValueEx(key, VALUE_NAME)
            return str(value)
    except FileNotFoundError:
        return None
    except OSError:
        return None
    except ImportError:
        return None


# --- Linux XDG auto-start helpers --------------------------------------------


def _is_linux() -> bool:
    return sys.platform.startswith("linux")


def _linux_autostart_path() -> Path:
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return config_home / "autostart" / "sara.desktop"


def _linux_session_executable() -> str | None:
    configured = os.environ.get("SARA_SESSION_EXECUTABLE", "").strip()
    if configured and Path(configured).is_file() and os.access(configured, os.X_OK):
        return configured
    found = shutil.which("sara-session")
    if found:
        return found
    installed = Path("/usr/local/bin/sara-session")
    return str(installed) if installed.is_file() and os.access(installed, os.X_OK) else None


def _write_linux_autostart(*, hidden: bool) -> Path:
    path = _linux_autostart_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if hidden:
        content = """[Desktop Entry]
Type=Application
Name=Sara
Hidden=true
"""
    else:
        executable = _linux_session_executable()
        if not executable:
            raise ToolError("Sara's Linux session launcher is not installed, so auto-start cannot be enabled.")
        content = f"""[Desktop Entry]
Type=Application
Version=1.0
Name=Sara
Comment=Open the Sara AI operating environment
Exec={executable}
Terminal=false
X-GNOME-Autostart-enabled=true
"""
    try:
        path.write_text(content, encoding="utf-8")
        path.chmod(0o600)
    except OSError as error:
        raise ToolError(f"Could not update Linux auto-start: {error}") from error
    return path


def _linux_autostart_status() -> tuple[bool, str | None]:
    user_entry = _linux_autostart_path()
    if user_entry.is_file():
        parser = configparser.ConfigParser(interpolation=None)
        parser.optionxform = str
        try:
            parser.read(user_entry, encoding="utf-8")
            entry = parser["Desktop Entry"]
            hidden = entry.get("Hidden", "false").casefold() in {"true", "1", "yes"}
            enabled = entry.get("X-GNOME-Autostart-enabled", "true").casefold() not in {"false", "0", "no"}
            return (not hidden and enabled), str(user_entry)
        except (OSError, UnicodeError, KeyError, configparser.Error):
            return False, str(user_entry)
    for config_dir in os.environ.get("XDG_CONFIG_DIRS", "/etc/xdg").split(":"):
        system_entry = Path(config_dir) / "autostart" / "sara.desktop"
        if system_entry.is_file():
            return True, str(system_entry)
    return False, None


# --- Tools -------------------------------------------------------------------

@register("enableAutoStart")
def enable_auto_start(args: Dict[str, Any]) -> Dict[str, Any]:
    """Create a per-user Windows or freedesktop auto-start entry."""
    if _is_linux():
        launcher = _write_linux_autostart(hidden=False)
        return {
            "result": "Auto-start enabled. Sara will launch on the next Linux desktop login.",
            "enabled": True,
            "launcher": str(launcher),
            "method": "xdg_autostart",
        }
    if not _is_windows():
        raise ToolError("Auto-start is unsupported on this platform.")
    command, launcher = _startup_command()
    import winreg  # type: ignore[import-not-found]

    try:
        with _open_run_key() as key:
            winreg.SetValueEx(key, VALUE_NAME, 0, winreg.REG_SZ, command)
    except OSError as e:
        raise ToolError(f"Could not write startup registry entry: {e}") from e

    return {
        "result": "Auto-start enabled. Myraa will launch silently on next Windows login.",
        "enabled": True,
        "launcher": launcher,
        "registry_key": f"HKCU\\{RUN_KEY_PATH}\\{VALUE_NAME}",
    }


@register("disableAutoStart")
def disable_auto_start(args: Dict[str, Any]) -> Dict[str, Any]:
    """Disable per-user startup, overriding a system XDG default if needed."""
    if _is_linux():
        launcher = _write_linux_autostart(hidden=True)
        return {
            "result": "Auto-start disabled for this Linux user.",
            "enabled": False,
            "launcher": str(launcher),
            "method": "xdg_autostart_override",
        }
    if not _is_windows():
        raise ToolError("Auto-start is unsupported on this platform.")
    existing = _read_run_value()
    if existing is None:
        return {"result": "Auto-start was already disabled.", "enabled": False}
    import winreg  # type: ignore[import-not-found]

    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, RUN_KEY_PATH, 0, winreg.KEY_SET_VALUE
        ) as key:
            winreg.DeleteValue(key, VALUE_NAME)
    except FileNotFoundError:
        return {"result": "Auto-start was already disabled.", "enabled": False}
    except OSError as e:
        raise ToolError(f"Could not remove startup registry entry: {e}") from e

    return {
        "result": "Auto-start disabled. Myraa will no longer launch on login.",
        "enabled": False,
    }


@register("getAutoStartStatus")
def get_auto_start_status(args: Dict[str, Any]) -> Dict[str, Any]:
    """Report whether auto-start is currently enabled."""
    if _is_linux():
        enabled, launcher = _linux_autostart_status()
        return {
            "result": "Auto-start is ENABLED for the Linux desktop." if enabled else "Auto-start is DISABLED for the Linux desktop.",
            "enabled": enabled,
            "launcher": launcher,
            "platform": sys.platform,
            "method": "xdg_autostart",
        }
    if not _is_windows():
        return {"result": "Auto-start is unsupported on this platform.", "enabled": False, "platform": sys.platform}
    value = _read_run_value()
    enabled = value is not None
    return {
        "result": (
            "Auto-start is ENABLED. Myraa launches on Windows login."
            if enabled
            else "Auto-start is DISABLED."
        ),
        "enabled": enabled,
        "launcher": value,
        "platform": sys.platform,
    }
