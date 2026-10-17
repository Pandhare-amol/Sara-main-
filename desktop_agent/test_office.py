import tempfile
import unittest
from pathlib import Path

from desktop_agent.registry import DESKTOP_TOOL_NAMES, TOOLS, ToolError
from desktop_agent.tools_office import _destination, office_status


class OfficeToolsTests(unittest.TestCase):
    def test_office_tools_are_registered(self):
        expected = {"officeStatus", "officeCreateWord", "officeCreateWorkbook", "officeCreatePresentation", "officeExportPdf"}
        self.assertTrue(expected.issubset(set(DESKTOP_TOOL_NAMES)))
        self.assertTrue(expected.issubset(set(TOOLS)))

    def test_status_is_explicit_off_windows(self):
        value = office_status({})
        self.assertIn("applications", value)
        self.assertEqual(set(value["applications"]), {"word", "excel", "powerpoint"})
        self.assertTrue(all(isinstance(item, bool) for item in value["applications"].values()))

    def test_destination_rejects_wrong_extension_and_overwrite(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ToolError, "must end in .docx"):
                _destination(str(root / "report.txt"), ".docx")
            existing = root / "report.docx"
            existing.write_bytes(b"already here")
            with self.assertRaisesRegex(ToolError, "already exists"):
                _destination(str(existing), ".docx")


if __name__ == "__main__":
    unittest.main()
