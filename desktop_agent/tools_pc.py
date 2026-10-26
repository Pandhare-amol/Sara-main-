"""
PC control: system volume and (gated) power actions.

Volume:
  Uses pycaw + comtypes for precise scalar control on Windows when available,
  with a graceful media-key fallback (VK_VOLUME_UP/DOWN/MUTE via keybd_event)
  through pyautogui.

Power:
  shutdown / restart / sleep / lock are DANGEROUS and require the two-step
  confirmation flow (tools_confirmation). `executePowerAction` consumes the
  token before running anything destructive.
"""

from __future__ import annotations

import ctypes
import os
import platform
import re
import shutil
import subprocess
import time
from typing import Any, Dict, Optional

from .registry import ToolError, register
from .tools_confirmation import ACTION_LABEL, consume_token


# --- Volume backend (lazy) ----------------------------------------------------

_vol_backend = None  # one of "pycaw" | "pipewire" | "media_keys" | None


def _wpctl(*arguments: str) -> subprocess.CompletedProcess[str]:
    executable = shutil.which("wpctl")
    if not executable:
        raise ToolError("PipeWire volume control is unavailable because wpctl is not installed.")
    try:
        return subprocess.run(
            [executable, *arguments], capture_output=True, text=True,
            timeout=5, check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ToolError(f"PipeWire volume control failed: {error}") from error


def _pipewire_state() -> tuple[float, bool]:
    result = _wpctl("get-volume", "@DEFAULT_AUDIO_SINK@")
    if result.returncode != 0:
        raise ToolError(result.stderr.strip() or "Could not read the default PipeWire audio sink.")
    match = re.search(r"Volume:\s*([0-9]+(?:\.[0-9]+)?)", result.stdout)
    if not match:
        raise ToolError("wpctl returned an unrecognized volume state.")
    return max(0.0, min(1.5, float(match.group(1)))), "[MUTED]" in result.stdout.upper()


def _init_pycaw():
    try:
        from ctypes import cast, POINTER

        import comtypes  # noqa: F401
        from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume

        devices = AudioUtilities.GetSpeakers()
        interface = devices.Activate(IAudioEndpointVolume._iid_, comtypes.CLSCTX_ALL, None)
        volume = cast(interface, POINTER(IAudioEndpointVolume))
        return volume
    except Exception:
        return None


def _get_volume_interface():
    global _vol_backend
    if _vol_backend is None:
        if platform.system() == "Linux" and shutil.which("wpctl"):
            _vol_backend = "pipewire"
        elif platform.system() != "Windows":
            _vol_backend = "media_keys"
        else:
            iface = _init_pycaw()
            _vol_backend = "pycaw" if iface is not None else "media_keys"
            if _vol_backend == "pycaw":
                _VOL_CACHE["iface"] = iface
    return _vol_backend


_VOL_CACHE: Dict[str, Any] = {}


def _current_volume() -> float:
    """Return the verified master volume in normalized 0.0..1.0 units."""
    backend = _get_volume_interface()
    if backend == "pipewire":
        return min(1.0, _pipewire_state()[0])
    if backend == "pycaw":
        iface = _VOL_CACHE.get("iface") or _init_pycaw()
        if iface is not None:
            _VOL_CACHE["iface"] = iface
            try:
                return float(iface.GetMasterVolumeLevelScalar())
            except Exception:
                pass
    if backend == "media_keys":
        raise ToolError("Exact system volume cannot be read on this platform.")
    raise ToolError("System volume is unavailable.")


def _set_volume_scalar(value: float) -> None:
    value = max(0.0, min(1.0, float(value)))
    backend = _get_volume_interface()
    if backend == "pipewire":
        result = _wpctl("set-volume", "@DEFAULT_AUDIO_SINK@", f"{round(value * 100)}%")
        if result.returncode != 0:
            raise ToolError(result.stderr.strip() or "PipeWire refused the volume change.")
        actual, _muted = _pipewire_state()
        if abs(actual - value) > 0.03:
            raise ToolError(f"PipeWire did not verify the requested volume (reported {actual:.2f}).")
        return
    if backend == "pycaw":
        iface = _VOL_CACHE.get("iface") or _init_pycaw()
        if iface is not None:
            _VOL_CACHE["iface"] = iface
            try:
                iface.SetMasterVolumeLevelScalar(value, None)
                return
            except Exception:
                pass  # fall through to media keys
    raise ToolError("Exact volume setting is unavailable because the system audio level cannot be read.")


# VK codes for media keys
VK_VOLUME_MUTE = 0xAD
VK_VOLUME_UP = 0xAF
VK_VOLUME_DOWN = 0xAE
KEYEVENTF_KEYUP = 0x0002


def _press_vk(vk: int) -> None:
    try:
        ctypes.windll.user32.keybd_event(vk, 0, 0, 0)
        time.sleep(0.03)
        ctypes.windll.user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
    except Exception:
        # pyautogui fallback
        try:
            import pyautogui

            if vk == VK_VOLUME_UP:
                pyautogui.press("volumeup")
            elif vk == VK_VOLUME_DOWN:
                pyautogui.press("volumedown")
            elif vk == VK_VOLUME_MUTE:
                pyautogui.press("volumemute")
        except Exception as error:
            raise ToolError(f"Could not send a system volume key: {error}") from error


def _press_volume_steps(vk: int, amount: float) -> int:
    """Send bounded media-key steps when an exact volume API is unavailable."""
    steps = max(1, min(20, int(round(max(0.01, amount) / 0.02))))
    for _ in range(steps):
        _press_vk(vk)
        time.sleep(0.01)
    return steps


def _toggle_mute_pycaw() -> Optional[bool]:
    backend = _get_volume_interface()
    if backend == "pipewire":
        result = _wpctl("set-mute", "@DEFAULT_AUDIO_SINK@", "toggle")
        if result.returncode != 0:
            raise ToolError(result.stderr.strip() or "PipeWire refused the mute change.")
        _volume, muted = _pipewire_state()
        return muted
    iface = _VOL_CACHE.get("iface")
    if iface is None:
        iface = _init_pycaw()
    if iface is not None:
        _VOL_CACHE["iface"] = iface
        try:
            iface.SetMute(1 if not bool(iface.GetMute()) else 0, None)
            return bool(iface.GetMute())
        except Exception:
            pass
    _press_vk(VK_VOLUME_MUTE)
    time.sleep(0.05)
    return None


# --- Tool handlers -----------------------------------------------------------


@register("volumeUp")
def volume_up(args: Dict[str, Any]) -> Dict[str, Any]:
    step = max(0.01, min(1.0, float(args.get("amount", 0.10))))
    backend = _get_volume_interface()
    if backend == "media_keys":
        steps = _press_volume_steps(VK_VOLUME_UP, step)
        return {"result": "Sent a system volume-up request; the resulting level is not readable on this platform.", "backend": backend, "key_steps": steps}
    new = min(1.0, _current_volume() + step)
    _set_volume_scalar(new)
    return {"result": f"Volume increased to {int(new * 100)}%.", "percent": int(new * 100), "backend": backend}


@register("volumeDown")
def volume_down(args: Dict[str, Any]) -> Dict[str, Any]:
    step = max(0.01, min(1.0, float(args.get("amount", 0.10))))
    backend = _get_volume_interface()
    if backend == "media_keys":
        steps = _press_volume_steps(VK_VOLUME_DOWN, step)
        return {"result": "Sent a system volume-down request; the resulting level is not readable on this platform.", "backend": backend, "key_steps": steps}
    new = max(0.0, _current_volume() - step)
    _set_volume_scalar(new)
    return {"result": f"Volume decreased to {int(new * 100)}%.", "percent": int(new * 100), "backend": backend}


@register("setVolume")
def set_volume(args: Dict[str, Any]) -> Dict[str, Any]:
    if "percent" in args:
        pct = float(args["percent"])
    elif "level" in args:
        pct = float(args["level"])
    else:
        raise ToolError("Parameter 'percent' (0-100) is required.")
    pct = max(0.0, min(100.0, pct))
    _set_volume_scalar(pct / 100.0)
    return {"result": f"Volume set to {int(pct)}%.", "percent": int(pct), "backend": _get_volume_interface()}


@register("muteToggle")
def mute_toggle(args: Dict[str, Any]) -> Dict[str, Any]:
    muted = _toggle_mute_pycaw()
    backend = _get_volume_interface()
    if muted is None:
        return {"result": "Sent a system mute-toggle request; the resulting state is not readable on this platform.", "backend": backend}
    return {"result": "Muted." if muted else "Unmuted.", "muted": muted, "backend": backend}


# --- Gated power actions -----------------------------------------------------


def _checked_system_command(command: list[str], description: str) -> None:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=15, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise ToolError(f"Could not request {description}: {error}") from error
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise ToolError(f"The operating system refused {description}: {detail}")


def _run_power(action: str) -> str:
    """Execute a confirmed power action and report only OS-accepted requests."""
    system = platform.system()
    if action == "lock":
        if system == "Windows":
            ctypes.windll.user32.LockWorkStation()
            return "Computer locked."
        if system == "Linux":
            if shutil.which("loginctl"):
                _checked_system_command(["loginctl", "lock-session"], "screen lock")
            elif shutil.which("xdg-screensaver"):
                _checked_system_command(["xdg-screensaver", "lock"], "screen lock")
            else:
                raise ToolError("No Linux screen-lock service is installed.")
            return "Linux session accepted the screen-lock request."
        raise ToolError("Screen lock is unsupported on this platform.")
    if action == "sleep":
        if system == "Windows":
            os.system("rundll32.exe powrprof.dll,SetSuspendState 0,1,0")
            return "Computer going to sleep."
        if system != "Linux":
            raise ToolError("System suspend is unsupported on this platform.")
        _checked_system_command(["systemctl", "suspend"], "system suspend")
        return "Linux system accepted the suspend request."
    if action == "restart":
        if system == "Windows":
            _checked_system_command(["shutdown", "/r", "/t", "5"], "system restart")
            return "Computer restarting in 5 seconds."
        if system != "Linux":
            raise ToolError("System restart is unsupported on this platform.")
        _checked_system_command(["systemctl", "reboot"], "system restart")
        return "Linux system accepted the restart request."
    if action == "shutdown":
        if system == "Windows":
            _checked_system_command(["shutdown", "/s", "/t", "10"], "system shutdown")
            return "Computer shutting down in 10 seconds."
        if system != "Linux":
            raise ToolError("System shutdown is unsupported on this platform.")
        _checked_system_command(["systemctl", "poweroff"], "system shutdown")
        return "Linux system accepted the shutdown request."
    raise ToolError(f"Unknown power action '{action}'.")


@register("executePowerAction")
def execute_power_action(args: Dict[str, Any]) -> Dict[str, Any]:
    action = (args.get("action") or "").strip().lower()
    token: Optional[str] = args.get("execute_token")

    # Locking is comparatively safe but still gated per the user's spec
    # (all four dangerous actions require confirmation).
    from .tools_confirmation import DANGEROUS_ACTIONS

    if action not in DANGEROUS_ACTIONS:
        raise ToolError(
            f"Unknown power action '{action}'. Valid: {', '.join(sorted(DANGEROUS_ACTIONS))}."
        )

    consume_token(action, token)  # raises if invalid/missing/expired
    msg = _run_power(action)
    return {"result": msg, "action": action}


# Helper for shell-level abort of a pending Windows shutdown/restart timer.
@register("_cancelPowerTimer")
def _cancel(args: Dict[str, Any]) -> Dict[str, Any]:  # pragma: no cover
    if platform.system() != "Windows":
        raise ToolError("Pending power-timer cancellation is only available for Windows timers.")
    result = subprocess.run(["shutdown", "/a"], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise ToolError(result.stderr.strip() or "Windows did not cancel a pending power timer.")
    return {"result": "Cancelled pending shutdown/restart timer."}


# --- Brightness control ------------------------------------------------------
# Uses screen_brightness_control when available, brightnessctl on Linux, and a
# WMI/PowerShell fallback on Windows. Missing hardware or authorization is
# surfaced explicitly. Lazy import keeps the agent bootable without extras.

_sbc = None  # cached module handle

def _brightness_backend():
    """Return the screen_brightness_control module, or None if unavailable."""
    global _sbc
    if _sbc is not None:
        return _sbc if _sbc is not False else None
    try:
        import screen_brightness_control as sbc  # type: ignore[import-not-found]

        _sbc = sbc
        return sbc
    except Exception:  # noqa: BLE001 - optional dependency
        _sbc = False
        return None


def _current_brightness() -> int:
    sbc = _brightness_backend()
    if sbc is not None:
        try:
            vals = sbc.get_brightness()
            if vals:
                return int(round(sum(vals) / len(vals)))
        except Exception:  # noqa: BLE001
            pass
    if platform.system() == "Linux" and shutil.which("brightnessctl"):
        try:
            output = subprocess.check_output(
                ["brightnessctl", "-m", "info"], text=True, timeout=5,
            )
            percentages = re.findall(r"(?:^|,)(\d+)%(?:,|$)", output.strip())
            if percentages:
                return max(0, min(100, int(percentages[-1])))
            match = re.search(r"\((\d+)%\)", output)
            if match:
                return max(0, min(100, int(match.group(1))))
        except Exception:
            pass
    # Windows WMI fallback via PowerShell (does not need extra deps).
    if platform.system() == "Windows":
        try:
            out = subprocess.check_output(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    "(Get-WmiObject -Namespace root/WMI "
                    "-Class WmiMonitorBrightness).WmiCurrentBrightness",
                ],
                text=True,
                timeout=8,
            ).strip()
            if out:
                return int(out.splitlines()[-1].strip())
        except Exception:  # noqa: BLE001
            pass
    raise ToolError("Brightness control is not supported on this device.")


def _set_brightness(pct: float) -> int:
    pct = max(0.0, min(100.0, pct))
    sbc = _brightness_backend()
    if sbc is not None:
        try:
            sbc.set_brightness(int(pct))
            return int(pct)
        except Exception:  # noqa: BLE001
            pass
    if platform.system() == "Linux" and shutil.which("brightnessctl"):
        try:
            result = subprocess.run(
                ["brightnessctl", "set", f"{int(pct)}%"],
                capture_output=True, text=True, timeout=8, check=False,
            )
            if result.returncode != 0:
                raise ToolError(result.stderr.strip() or "brightnessctl refused the brightness change.")
            actual = _current_brightness()
            if abs(actual - int(pct)) > 3:
                raise ToolError(f"Brightness did not verify at the requested level (reported {actual}%).")
            return actual
        except ToolError:
            raise
        except Exception as error:
            raise ToolError(f"Could not set Linux brightness: {error}") from error
    if platform.system() == "Windows":
        # WMI setter requires a method call; shell out to PowerShell.
        try:
            subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    (
                        "$m = Get-WmiObject -Namespace root/WMI "
                        "-Class WmiMonitorBrightnessMethods; "
                        f"$m.WmiSetBrightness(1,{int(pct)})"
                    ),
                ],
                check=False,
                timeout=8,
            )
            return int(pct)
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Could not set brightness: {e}") from e
    raise ToolError("Brightness control is not supported on this device.")


@register("brightnessUp")
def brightness_up(args: Dict[str, Any]) -> Dict[str, Any]:
    step = float(args.get("amount", 10))
    current = _current_brightness()
    new = _set_brightness(current + step)
    return {"result": f"Brightness increased to {new}%.", "brightness": new}


@register("brightnessDown")
def brightness_down(args: Dict[str, Any]) -> Dict[str, Any]:
    step = float(args.get("amount", 10))
    current = _current_brightness()
    new = _set_brightness(current - step)
    return {"result": f"Brightness decreased to {new}%.", "brightness": new}


@register("setBrightness")
def set_brightness(args: Dict[str, Any]) -> Dict[str, Any]:
    if "percent" in args:
        pct = float(args["percent"])
    elif "level" in args:
        pct = float(args["level"])
    else:
        raise ToolError("Parameter 'percent' (0-100) is required.")
    new = _set_brightness(pct)
    return {"result": f"Brightness set to {new}%.", "brightness": new}


__all__ = [
    "volume_up",
    "volume_down",
    "set_volume",
    "mute_toggle",
    "execute_power_action",
    "ACTION_LABEL",
    "brightness_up",
    "brightness_down",
    "set_brightness",
]
