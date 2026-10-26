from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from desktop_agent import perception, tools_windows


class SaraOsDesktopTests(unittest.TestCase):
    @patch.object(tools_windows.platform, "system", return_value="Linux")
    @patch.object(tools_windows.subprocess, "run")
    def test_linux_maximize_uses_semantic_window_id(self, run, _system) -> None:
        run.side_effect = [
            SimpleNamespace(returncode=0, stdout="4242\n", stderr=""),
            SimpleNamespace(returncode=0, stdout="Sara\n", stderr=""),
            SimpleNamespace(returncode=0, stdout="", stderr=""),
        ]
        result = tools_windows.maximize_window({})
        self.assertIn("Maximized", result["result"])
        self.assertEqual(
            run.call_args_list[-1].args[0],
            ["wmctrl", "-ir", "4242", "-b", "add,maximized_vert,maximized_horz"],
        )

    @patch.object(tools_windows.platform, "system", return_value="Linux")
    @patch.object(tools_windows.subprocess, "run")
    def test_linux_close_by_title_uses_wmctrl_not_coordinates(self, run, _system) -> None:
        run.side_effect = [
            SimpleNamespace(returncode=0, stdout="0x02a00007  0 host Sara Settings\n", stderr=""),
            SimpleNamespace(returncode=0, stdout="", stderr=""),
        ]
        result = tools_windows.close_window({"title": "Sara Settings"})
        self.assertIn("Closed", result["result"])
        self.assertEqual(run.call_args_list[-1].args[0], ["wmctrl", "-ic", "0x02a00007"])

    @patch.object(perception.platform, "system", return_value="Linux")
    @patch.object(perception.subprocess, "run")
    @patch.object(perception, "psutil")
    def test_linux_active_window_snapshot_is_metadata_only(self, psutil, run, _system) -> None:
        process = SimpleNamespace(name=lambda: "chromium")
        psutil.Process.return_value = process
        run.side_effect = [
            SimpleNamespace(stdout="4242\n"),
            SimpleNamespace(stdout="Sara\n"),
            SimpleNamespace(stdout="99\n"),
        ]
        active = perception._active_window()
        self.assertEqual(active, {"title": "Sara", "application": "chromium", "pid": 99})
        self.assertTrue(all("screenshot" not in call.args[0] for call in run.call_args_list))


if __name__ == "__main__":
    unittest.main()
