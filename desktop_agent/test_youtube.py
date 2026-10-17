"""Deterministic mocked tests for the real-browser YouTube adapter.

These do not claim a live YouTube/browser run. They exercise selection,
routing, verification, isolation and failure behavior with browser/SMTC/UIA
boundaries mocked. Live Windows acceptance remains an explicitly separate
manual test described in the delivery audit.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from desktop_agent.registry import ToolError
from desktop_agent import tools_youtube as yt


WATCH = "https://www.youtube.com/watch?v=abcdefghijk"
WATCH_2 = "https://www.youtube.com/watch?v=lmnopqrstuv"
PLAYLIST = WATCH + "&list=PL1234567890"


def state(**extra):
    value = {
        "active": True,
        "browser_hwnd": 10,
        "browser": "chrome",
        "title": "Test video",
        "channel": "Test Channel",
        "url": WATCH,
        "video_id": "abcdefghijk",
        "playlist_id": None,
        "playback_state": "playing",
        "position_seconds": 12.0,
        "duration_seconds": 120.0,
        "volume_percent": 60,
        "muted": False,
        "fullscreen": False,
        "captions_enabled": False,
        "playback_rate": 1.0,
        "search_query": "test video",
        "result_index": 1,
        "selection_kind": "video",
        "task_status": "playing",
        "error_code": None,
        "error": None,
        "verified_fields": ["url", "video_id", "title", "playback_state"],
    }
    value.update(extra)
    return value


class YoutubeParsingTests(unittest.TestCase):
    def test_video_and_playlist_ids_are_parsed_only_from_youtube(self):
        self.assertEqual(yt._video_id(WATCH), "abcdefghijk")
        self.assertEqual(yt._video_id("https://youtu.be/abcdefghijk"), "abcdefghijk")
        self.assertEqual(yt._video_id("https://www.youtube.com/shorts/abcdefghijk"), "abcdefghijk")
        self.assertEqual(yt._playlist_id(PLAYLIST), "PL1234567890")
        self.assertIsNone(yt._video_id("https://example.com/watch?v=abcdefghijk"))

    def test_result_selection_uses_semantic_links_and_requested_order(self):
        elements = [
            {"id": "e1", "role": "link", "name": "YouTube Home", "rect": {"top": 10}, "enabled": True},
            {"id": "e2", "role": "link", "name": "Believer - Imagine Dragons", "target_url": WATCH, "rect": {"top": 150}, "enabled": True},
            {"id": "e3", "role": "link", "name": "Imagine Dragons", "rect": {"top": 220}, "enabled": True},
            {"id": "e4", "role": "link", "name": "Believer live performance", "target_url": WATCH_2, "rect": {"top": 300}, "enabled": True},
        ]
        candidates = yt._result_candidates(elements, "Believer Imagine Dragons", "video")
        self.assertEqual([item["id"] for item in candidates[:2]], ["e2", "e4"])
        self.assertNotIn("e1", [item["id"] for item in candidates])

    @patch.object(yt, "_inspect", return_value={
        "snapshot_id": "s1",
        "elements": [{"id": "e1", "role": "slider", "name": "Volume", "value": 0.6, "minimum": 0.0, "maximum": 1.0, "actions": ["range_value"]}],
    })
    def test_player_volume_range_is_normalized_to_percent(self, _inspect):
        self.assertEqual(yt._uia_player_state(10)["volume_percent"], 60)

    @patch.object(yt, "_inspect", return_value={
        "snapshot_id": "s1",
        "elements": [
            {"id": "e1", "role": "link", "name": "Video one", "rect": {"top": 120}, "enabled": True},
            {"id": "e2", "role": "link", "name": "Channel one", "rect": {"top": 160}, "enabled": True},
        ],
    })
    def test_numbered_result_refuses_when_link_targets_are_not_semantically_exposed(self, _inspect):
        with self.assertRaisesRegex(ToolError, "RESULT_INDEX_UNVERIFIABLE"):
            yt._select_visible_result(10, "video", 2, "video")

    def test_playlist_candidates_require_playlist_semantics(self):
        elements = [
            {"id": "e1", "role": "link", "name": "Focus music", "rect": {"top": 120}, "enabled": True},
            {"id": "e2", "role": "link", "name": "Focus music playlist", "target_url": "https://www.youtube.com/playlist?list=PL1234567890", "rect": {"top": 180}, "enabled": True},
        ]
        self.assertEqual([item["id"] for item in yt._result_candidates(elements, "focus music", "playlist")], ["e2"])


class YoutubePlayTests(unittest.TestCase):
    def setUp(self):
        yt._cancel_event().clear()

    @patch.object(yt, "_save_state", side_effect=lambda value: value)
    @patch.object(yt, "_play_or_pause", side_effect=lambda _hwnd, _desired, before: {**before, "playback_state": "playing"})
    @patch.object(yt, "_probe_state", return_value=state(playback_state="paused"))
    @patch.object(yt, "_select_visible_result", return_value={"selected_title": "Test video", "browser": {"url": WATCH}})
    @patch.object(yt, "_wait_for_url", return_value={"url": "https://www.youtube.com/results?search_query=test"})
    @patch.object(yt, "_navigate_youtube", return_value=(10, {"url": "https://www.youtube.com/results?search_query=test"}))
    @patch.object(yt, "_stored_state", return_value={})
    @patch.object(yt, "_require_windows")
    def test_search_to_play_returns_only_verified_watch_state(self, *_mocks):
        result = yt.youtube_play({"query": "test video", "result_index": 1})
        self.assertTrue(result["verified"])
        self.assertEqual(result["video_id"], "abcdefghijk")
        self.assertEqual(result["playback_state"], "playing")

    @patch.object(yt, "_save_state", side_effect=lambda value: value)
    @patch.object(yt, "_probe_state", return_value=state(url=PLAYLIST, playlist_id="PL1234567890"))
    @patch.object(yt, "_select_visible_result", return_value={"selected_title": "Focus playlist", "browser": {"url": PLAYLIST}})
    @patch.object(yt, "_wait_for_url", return_value={"url": "https://www.youtube.com/results?search_query=focus"})
    @patch.object(yt, "_navigate_youtube", return_value=(10, {"url": "https://www.youtube.com/results?search_query=focus"}))
    @patch.object(yt, "_stored_state", return_value={})
    @patch.object(yt, "_require_windows")
    def test_playlist_selection_requires_list_context(self, *_mocks):
        result = yt.youtube_play({"query": "focus", "playlist": True, "start_playback": False})
        self.assertTrue(result["verified"])
        self.assertEqual(result["playlist_id"], "PL1234567890")

    @patch.object(yt, "_save_state", side_effect=lambda value: value)
    @patch.object(yt, "_play_or_pause", side_effect=ToolError("AUTOPLAY_BLOCKED: click required"))
    @patch.object(yt, "_probe_state", return_value=state(playback_state="paused"))
    @patch.object(yt, "_select_visible_result", return_value={"selected_title": "Test video", "browser": {"url": WATCH}})
    @patch.object(yt, "_wait_for_url", return_value={"url": "https://www.youtube.com/results?search_query=test"})
    @patch.object(yt, "_navigate_youtube", return_value=(10, {"url": "https://www.youtube.com/results?search_query=test"}))
    @patch.object(yt, "_stored_state", return_value={})
    @patch.object(yt, "_require_windows")
    def test_autoplay_restriction_is_not_reported_as_success(self, *_mocks):
        with self.assertRaisesRegex(ToolError, "AUTOPLAY_BLOCKED"):
            yt.youtube_play({"query": "test video"})

    @patch.object(yt, "_save_state", side_effect=lambda value: value)
    @patch.object(yt, "_probe_state", return_value=state(error_code="VIDEO_UNAVAILABLE", error="video unavailable"))
    @patch.object(yt, "_navigate_youtube", return_value=(10, {"url": WATCH, "title": "Video unavailable - YouTube"}))
    @patch.object(yt, "_stored_state", return_value={})
    @patch.object(yt, "_require_windows")
    def test_missing_video_error_is_preserved(self, *_mocks):
        with self.assertRaisesRegex(ToolError, "VIDEO_UNAVAILABLE"):
            yt.youtube_play({"url": WATCH})

    @patch.object(yt, "_save_state", side_effect=lambda value: value)
    @patch.object(yt, "_probe_state", return_value=state(error_code="PLAYER_ERROR", error="something went wrong"))
    @patch.object(yt, "_navigate_youtube", return_value=(10, {"url": WATCH, "title": "YouTube"}))
    @patch.object(yt, "_stored_state", return_value={})
    @patch.object(yt, "_require_windows")
    def test_player_error_is_preserved(self, *_mocks):
        with self.assertRaisesRegex(ToolError, "PLAYER_ERROR"):
            yt.youtube_play({"url": WATCH})


class YoutubeControlTests(unittest.TestCase):
    def setUp(self):
        yt._cancel_event().clear()
        self.base = state()
        self.common = [
            patch.object(yt, "_require_windows"),
            patch.object(yt, "_find_youtube_window", return_value=(10, {"url": WATCH})),
            patch.object(yt, "_focus"),
            patch.object(yt, "_save_state", side_effect=lambda value: value),
        ]
        for item in self.common:
            item.start()
            self.addCleanup(item.stop)

    def test_pause_and_resume_delegate_to_verified_state_transition(self):
        with patch.object(yt, "_probe_state", side_effect=[state(playback_state="playing"), state(playback_state="paused")]), \
             patch.object(yt, "_play_or_pause", side_effect=lambda _h, desired, _b: state(playback_state=desired)) as transition:
            paused = yt.youtube_control({"action": "pause"})
            self.assertEqual(paused["playback_state"], "paused")
            transition.assert_called_once()
        with patch.object(yt, "_probe_state", return_value=state(playback_state="paused")), \
             patch.object(yt, "_play_or_pause", return_value=state(playback_state="playing")):
            resumed = yt.youtube_control({"action": "play"})
            self.assertEqual(resumed["playback_state"], "playing")

    def test_next_changes_video_and_playlist_previous_uses_player_navigation(self):
        changed = state(url=WATCH_2, video_id="lmnopqrstuv", title="Next video", playlist_id="PL1234567890")
        with patch.object(yt, "_probe_state", return_value=state(url=PLAYLIST, playlist_id="PL1234567890")), \
             patch.object(yt, "_media_command", return_value={"command_succeeded": True}), \
             patch.object(yt, "_wait_state", return_value=changed):
            result = yt.youtube_control({"action": "next"})
            self.assertEqual(result["video_id"], "lmnopqrstuv")
        with patch.object(yt, "_probe_state", return_value=changed), \
             patch.object(yt, "_media_command", return_value={"command_succeeded": True}), \
             patch.object(yt, "_wait_state", return_value=state(url=PLAYLIST, playlist_id="PL1234567890")):
            result = yt.youtube_control({"action": "previous"})
            self.assertEqual(result["playlist_id"], "PL1234567890")

    def test_range_value_player_volume_uses_semantic_slider_not_system_audio(self):
        player = {
            "snapshot": {"snapshot_id": "s1"},
            "volume_element": {"id": "e1", "role": "slider", "name": "Volume", "actions": ["range_value"], "minimum": 0.0, "maximum": 1.0},
        }
        with patch.object(yt, "_uia_player_state", return_value=player), \
             patch("desktop_agent.tools_uia.ui_action") as action, \
             patch.object(yt, "_wait_state", return_value=state(volume_percent=40)):
            result = yt._set_volume(10, 40)
        self.assertEqual(result["volume_percent"], 40)
        self.assertEqual(action.call_args.args[0]["action"], "set_range_value")
        self.assertEqual(action.call_args.args[0]["value"], "0.4")

    def test_seek_and_player_volume_are_verified_by_dedicated_helpers(self):
        with patch.object(yt, "_probe_state", return_value=state(position_seconds=10)), \
             patch.object(yt, "_seek", return_value=state(position_seconds=40)) as seek:
            result = yt.youtube_control({"action": "forward", "seconds": 30})
            self.assertEqual(result["position_seconds"], 40)
            seek.assert_called_once()
        with patch.object(yt, "_probe_state", return_value=state(volume_percent=60)), \
             patch.object(yt, "_set_volume", return_value=state(volume_percent=40)) as volume:
            result = yt.youtube_control({"action": "set_volume", "volume_percent": 40})
            self.assertEqual(result["volume_percent"], 40)
            volume.assert_called_once_with(10, 40)

    def test_mute_and_fullscreen_require_post_action_state(self):
        with patch.object(yt, "_probe_state", return_value=state(muted=False)), \
             patch.object(yt, "_click_player_control", return_value=True), \
             patch.object(yt, "_wait_state", return_value=state(muted=True)):
            self.assertTrue(yt.youtube_control({"action": "mute"})["muted"])
        with patch.object(yt, "_probe_state", return_value=state(fullscreen=False)), \
             patch.object(yt, "_click_player_control", return_value=True), \
             patch.object(yt, "_wait_state", return_value=state(fullscreen=True)):
            self.assertTrue(yt.youtube_control({"action": "enter_fullscreen"})["fullscreen"])

    def test_stop_restart_captions_and_speed_all_require_verified_helpers(self):
        with patch.object(yt, "_probe_state", return_value=state(playback_state="playing")), \
             patch.object(yt, "_play_or_pause", return_value=state(playback_state="paused", position_seconds=20)), \
             patch.object(yt, "_seek", return_value=state(playback_state="paused", position_seconds=0)):
            stopped = yt.youtube_control({"action": "stop"})
            self.assertTrue(stopped["stopped"])
            self.assertEqual(stopped["playback_state"], "paused")
        with patch.object(yt, "_probe_state", return_value=state(playback_state="paused", position_seconds=50)), \
             patch.object(yt, "_seek", return_value=state(playback_state="paused", position_seconds=0)), \
             patch.object(yt, "_play_or_pause", return_value=state(playback_state="playing", position_seconds=0)):
            restarted = yt.youtube_control({"action": "restart"})
            self.assertEqual(restarted["playback_state"], "playing")
        with patch.object(yt, "_probe_state", return_value=state(captions_enabled=False)), \
             patch.object(yt, "_click_player_control", return_value=True), \
             patch.object(yt, "_wait_state", return_value=state(captions_enabled=True)):
            self.assertTrue(yt.youtube_control({"action": "captions_on"})["captions_enabled"])
        with patch.object(yt, "_probe_state", return_value=state()), \
             patch.object(yt, "_set_speed", return_value=state(playback_rate=1.5)) as speed:
            self.assertEqual(yt.youtube_control({"action": "set_speed", "rate": 1.5})["playback_rate"], 1.5)
            speed.assert_called_once_with(10, 1.5)

    @patch.object(yt, "_stored_state", return_value={"search_query": "test video", "result_index": 1})
    @patch.object(yt, "youtube_play", return_value=state(video_id="lmnopqrstuv", verified=True))
    def test_another_result_uses_search_context(self, play, _stored):
        with patch.object(yt, "_probe_state", return_value=self.base):
            yt.youtube_control({"action": "another"})
        self.assertEqual(play.call_args.args[0]["result_index"], 2)


class YoutubeIsolationTests(unittest.TestCase):
    @patch.object(yt, "_require_windows")
    @patch.object(yt, "_stored_state", return_value={})
    @patch.object(yt, "_foreground_hwnd", return_value=20)
    @patch.object(yt, "_visible_browser_hwnds", return_value=[20, 21])
    @patch.object(yt, "_browser_state", side_effect=lambda hwnd: {"url": "https://example.com" if hwnd == 20 else "https://mail.google.com", "title": "Unrelated"})
    def test_unrelated_browser_tabs_are_never_selected(self, *_mocks):
        self.assertEqual(yt._find_youtube_window(required=False), (None, None))


if __name__ == "__main__":
    unittest.main()
