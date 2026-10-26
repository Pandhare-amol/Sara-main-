from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from desktop_agent import tools_startup


class StartupTests(unittest.TestCase):
    def test_packaged_runtime_uses_the_real_executable_without_python_or_npm(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "MYRAA runtime.exe"
            executable.write_bytes(b"test")
            with patch.dict(os.environ, {"MYRAA_EXECUTABLE": str(executable)}, clear=False):
                command, target = tools_startup._startup_command()
        self.assertEqual(command, f'"{executable}"')
        self.assertEqual(target, str(executable))
        self.assertNotIn("python", command.lower())
        self.assertNotIn("npm", command.lower())

    def test_linux_xdg_autostart_can_be_enabled_and_disabled_per_user(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"XDG_CONFIG_HOME": directory}, clear=False
        ), patch.object(tools_startup, "_is_linux", return_value=True), patch.object(
            tools_startup, "_linux_session_executable", return_value="/usr/local/bin/sara-session"
        ):
            enabled = tools_startup.enable_auto_start({})
            entry = Path(enabled["launcher"])
            self.assertTrue(entry.is_file())
            self.assertIn("Exec=/usr/local/bin/sara-session", entry.read_text(encoding="utf-8"))
            self.assertTrue(tools_startup.get_auto_start_status({})["enabled"])

            disabled = tools_startup.disable_auto_start({})
            self.assertFalse(disabled["enabled"])
            self.assertIn("Hidden=true", entry.read_text(encoding="utf-8"))
            self.assertFalse(tools_startup.get_auto_start_status({})["enabled"])

    def test_linux_autostart_reports_system_profile_default(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            system_entry = root / "autostart" / "sara.desktop"
            system_entry.parent.mkdir()
            system_entry.write_text("[Desktop Entry]\nType=Application\nName=Sara\n", encoding="utf-8")
            with patch.dict(
                os.environ,
                {"XDG_CONFIG_HOME": str(root / "user"), "XDG_CONFIG_DIRS": str(root)},
                clear=False,
            ), patch.object(tools_startup, "_is_linux", return_value=True):
                result = tools_startup.get_auto_start_status({})
        self.assertTrue(result["enabled"])
        self.assertEqual(result["launcher"], str(system_entry))


if __name__ == "__main__":
    unittest.main()
