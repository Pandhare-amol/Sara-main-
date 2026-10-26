from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from desktop_agent.registry import ToolError
from desktop_agent import tools_applications


class ApplicationDiscoveryTests(unittest.TestCase):
    def test_exact_installed_name_beats_similar_name(self) -> None:
        self.assertGreater(
            tools_applications._candidate_score("Steam", "Steam"),
            tools_applications._candidate_score("Steam", "SteamTools"),
        )
        self.assertEqual(tools_applications._candidate_score("Steam", "SteamTools"), 0)
        self.assertEqual(tools_applications._candidate_score("Discord", "Adobe Photoshop"), 0)

    @patch.object(tools_applications, "_launch_via_windows_search")
    @patch.object(tools_applications, "_discover_application", return_value=None)
    def test_unknown_app_uses_windows_search_instead_of_supported_list(self, _discover, search) -> None:
        result = tools_applications.open_application({"name": "A New Installed App"})
        search.assert_called_once_with("A New Installed App")
        self.assertEqual(result["method"], "windows_search_keyboard")

    @patch.object(tools_applications, "_launch_known")
    @patch.object(tools_applications.platform, "system", return_value="Linux")
    def test_sara_os_resolves_linux_desktop_applications(self, _system, launch) -> None:
        result = tools_applications.open_application({"name": "file explorer"})
        launch.assert_called_once()
        self.assertEqual(launch.call_args.args[0]["exe"], "thunar")
        self.assertEqual(result["application"], "Files")

    def test_linux_desktop_catalogue_filters_hidden_entries_and_never_runs_exec(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "org.example.Editor.desktop").write_text(
                """[Desktop Entry]
Type=Application
Name=Example Editor
Exec=example-editor --new-window %F
Categories=Utility;TextEditor;
StartupWMClass=ExampleEditor
""",
                encoding="utf-8",
            )
            (root / "hidden.desktop").write_text(
                """[Desktop Entry]
Type=Application
Name=Hidden Tool
Exec=do-not-run
NoDisplay=true
""",
                encoding="utf-8",
            )
            with patch.object(tools_applications, "_linux_desktop_dirs", return_value=[root]), patch.object(
                tools_applications.subprocess, "Popen"
            ) as popen:
                applications = list(tools_applications._linux_desktop_candidates())
        popen.assert_not_called()
        self.assertEqual(len(applications), 1)
        self.assertEqual(applications[0]["label"], "Example Editor")
        self.assertEqual(applications[0]["desktop_id"], "org.example.Editor")
        self.assertEqual(applications[0]["image"], "ExampleEditor")

    @patch.object(tools_applications.shutil, "which", return_value="/usr/bin/gtk-launch")
    @patch.object(tools_applications.subprocess, "Popen")
    @patch.object(tools_applications.platform, "system", return_value="Linux")
    def test_linux_discovered_application_uses_gtk_launch_not_exec(self, _system, popen, _which) -> None:
        tools_applications._launch_discovered(
            {
                "label": "Example Editor",
                "desktop_id": "org.example.Editor",
                "path": "/usr/share/applications/org.example.Editor.desktop",
                "method": "desktop_entry",
            }
        )
        self.assertEqual(popen.call_args.args[0], ["/usr/bin/gtk-launch", "org.example.Editor"])

    @patch.object(tools_applications, "_indexed_candidates")
    @patch.object(tools_applications.platform, "system", return_value="Linux")
    def test_list_applications_filters_linux_catalogue(self, _system, indexed) -> None:
        indexed.return_value = [
            {"label": "LibreOffice Writer", "desktop_id": "libreoffice-writer", "categories": "Office,WordProcessor", "method": "desktop_entry"},
            {"label": "VLC Media Player", "desktop_id": "vlc", "categories": "AudioVideo,Player", "method": "desktop_entry"},
        ]
        result = tools_applications.list_applications({"query": "office", "limit": 10})
        self.assertEqual([item["name"] for item in result["applications"]], ["LibreOffice Writer"])
        self.assertEqual(result["applications"][0]["id"], "libreoffice-writer")

    @patch.object(tools_applications.subprocess, "run")
    @patch.object(tools_applications.platform, "system", return_value="Linux")
    def test_sara_os_matches_semantic_x11_window(self, _system, run) -> None:
        run.return_value.stdout = "0x03a00007  0 1234 0 0 1200 800 chromium.Chromium host Sara - Chromium\n"
        matches = tools_applications._matching_windows("chromium")
        self.assertEqual(matches[0]["hwnd"], "0x03a00007")
        self.assertGreaterEqual(matches[0]["score"], 950)

    @patch.object(tools_applications, "_launch_discovered")
    @patch.object(tools_applications, "_discover_application")
    def test_discovered_app_is_launched(self, discover, launch) -> None:
        discover.return_value = {"label": "Steam", "path": "C:/Steam/steam.exe", "method": "installed_apps"}
        result = tools_applications.open_application({"name": "Steam"})
        launch.assert_called_once_with(discover.return_value)
        self.assertEqual(result["application"], "Steam")

    @patch.object(tools_applications, "_close_windows_with_keyboard", return_value=1)
    @patch.object(tools_applications, "_matching_windows")
    def test_arbitrary_visible_app_closes_with_keyboard(self, matching, close_windows) -> None:
        matching.return_value = [{"hwnd": 10, "title": "Example App", "score": 1000}]
        with patch.object(tools_applications.platform, "system", return_value="Windows"):
            result = tools_applications.close_application({"name": "Example App"})
        close_windows.assert_called_once()
        self.assertEqual(result["method"], "keyboard_alt_f4")

    @patch.object(tools_applications, "_matching_windows", return_value=[])
    def test_missing_running_app_reports_search_not_allowlist(self, _matching) -> None:
        with self.assertRaises(ToolError) as caught:
            tools_applications.close_application({"name": "Not Running"})
        self.assertIn("not limited by a supported-app list", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
