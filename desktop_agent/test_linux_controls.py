from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from desktop_agent import tools_pc
from desktop_agent.registry import ToolError


class LinuxControlTests(unittest.TestCase):
    def setUp(self) -> None:
        tools_pc._vol_backend = None
        tools_pc._VOL_CACHE.clear()

    @patch.object(tools_pc.platform, "system", return_value="Linux")
    @patch.object(tools_pc.shutil, "which", return_value="/usr/bin/wpctl")
    @patch.object(tools_pc.subprocess, "run")
    def test_pipewire_volume_is_changed_and_verified(self, run, _which, _system) -> None:
        run.side_effect = [
            SimpleNamespace(returncode=0, stdout="", stderr=""),
            SimpleNamespace(returncode=0, stdout="Volume: 0.42\n", stderr=""),
        ]
        result = tools_pc.set_volume({"percent": 42})
        self.assertEqual(result["percent"], 42)
        self.assertEqual(run.call_args_list[0].args[0], ["/usr/bin/wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "42%"])
        self.assertEqual(run.call_args_list[1].args[0], ["/usr/bin/wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"])

    @patch.object(tools_pc.platform, "system", return_value="Linux")
    @patch.object(tools_pc.shutil, "which", return_value="/usr/bin/wpctl")
    @patch.object(tools_pc.subprocess, "run")
    def test_pipewire_mute_reports_verified_state(self, run, _which, _system) -> None:
        run.side_effect = [
            SimpleNamespace(returncode=0, stdout="", stderr=""),
            SimpleNamespace(returncode=0, stdout="Volume: 0.42 [MUTED]\n", stderr=""),
        ]
        result = tools_pc.mute_toggle({})
        self.assertTrue(result["muted"])
        self.assertIn("muted", result["result"].lower())

    @patch.object(tools_pc.platform, "system", return_value="Linux")
    @patch.object(tools_pc.shutil, "which", return_value="/usr/bin/brightnessctl")
    @patch.object(tools_pc.subprocess, "check_output", return_value="intel_backlight,backlight,480,960,50%\n")
    @patch.object(tools_pc.subprocess, "run")
    def test_brightnessctl_change_is_verified(self, run, _check_output, _which, _system) -> None:
        run.return_value = SimpleNamespace(returncode=0, stdout="", stderr="")
        with patch.object(tools_pc, "_brightness_backend", return_value=None):
            result = tools_pc.set_brightness({"percent": 50})
        self.assertEqual(result["brightness"], 50)
        self.assertEqual(run.call_args.args[0], ["brightnessctl", "set", "50%"])

    @patch.object(tools_pc, "_press_vk")
    @patch.object(tools_pc.platform, "system", return_value="Darwin")
    def test_media_key_fallback_does_not_invent_a_volume_level(self, _system, press) -> None:
        result = tools_pc.volume_up({"amount": 0.1})
        self.assertNotIn("percent", result)
        self.assertIn("not readable", result["result"])
        self.assertGreaterEqual(press.call_count, 1)

    @patch.object(tools_pc.platform, "system", return_value="Linux")
    @patch.object(tools_pc.shutil, "which", return_value="/usr/bin/loginctl")
    @patch.object(tools_pc.subprocess, "run")
    def test_linux_lock_reports_only_accepted_request(self, run, _which, _system) -> None:
        run.return_value = SimpleNamespace(returncode=0, stdout="", stderr="")
        result = tools_pc._run_power("lock")
        self.assertIn("accepted", result)
        self.assertEqual(run.call_args.args[0], ["loginctl", "lock-session"])

    @patch.object(tools_pc.platform, "system", return_value="Linux")
    @patch.object(tools_pc.shutil, "which", return_value="/usr/bin/loginctl")
    @patch.object(tools_pc.subprocess, "run")
    def test_linux_lock_surfaces_os_refusal(self, run, _which, _system) -> None:
        run.return_value = SimpleNamespace(returncode=1, stdout="", stderr="Access denied")
        with self.assertRaises(ToolError) as caught:
            tools_pc._run_power("lock")
        self.assertIn("Access denied", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
