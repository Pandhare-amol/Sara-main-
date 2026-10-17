import tempfile
import unittest
import zipfile
from pathlib import Path

from desktop_agent.registry import DESKTOP_TOOL_NAMES, TOOLS, ToolError
from desktop_agent.tools_office import (
    _backup,
    _destination,
    _editable_source,
    _excel_assignment,
    _excel_updates,
    _presentation_edit_args,
    _restore,
    _sha256,
    _validated_cell,
    _verified_edit,
    _word_edit_args,
    office_status,
)


def _open_xml_fixture(path: Path, extra=None):
    with zipfile.ZipFile(path, "w") as package:
        package.writestr("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>")
        for name, content in (extra or {}).items():
            package.writestr(name, content)


class OfficeToolsTests(unittest.TestCase):
    def test_office_tools_are_registered(self):
        expected = {
            "officeStatus",
            "officeCreateWord",
            "officeCreateWorkbook",
            "officeCreatePresentation",
            "officeEditWord",
            "officeEditWorkbook",
            "officeEditPresentation",
            "officeExportPdf",
        }
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

    def test_edit_source_is_existing_bounded_open_xml_file(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
            root = Path(directory)
            source = root / "report.docx"
            _open_xml_fixture(source)
            self.assertEqual(_editable_source(str(source), ".docx"), source.resolve())
            with self.assertRaisesRegex(ToolError, r"must end.*\.xlsx"):
                _editable_source(str(source), ".xlsx")
            empty = root / "empty.docx"
            empty.touch()
            with self.assertRaisesRegex(ToolError, "empty"):
                _editable_source(str(empty), ".docx")

    def test_edit_source_rejects_active_and_linked_external_content(self):
        relationships = """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://example.invalid/template.dotx" TargetMode="External"/>
        </Relationships>"""
        with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
            root = Path(directory)
            macro = root / "macro.docx"
            _open_xml_fixture(macro, {"word/vbaProject.bin": b"not executable in the test"})
            with self.assertRaisesRegex(ToolError, "Macro or ActiveX"):
                _editable_source(str(macro), ".docx")
            linked = root / "linked.docx"
            _open_xml_fixture(linked, {"word/_rels/document.xml.rels": relationships})
            with self.assertRaisesRegex(ToolError, "linked external content"):
                _editable_source(str(linked), ".docx")

    def test_backup_is_exclusive_hash_verified_and_restorable(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
            source = Path(directory) / "report.docx"
            original = b"original office package bytes"
            source.write_bytes(original)
            backup, before_hash = _backup(source)
            self.assertTrue(backup.is_file())
            self.assertIn(".sara-backup-", backup.name)
            self.assertEqual(_sha256(backup), before_hash)
            self.assertEqual(backup.read_bytes(), original)

            source.write_bytes(b"changed package bytes")
            result = _verified_edit(source, backup, before_hash, "word", {"operation": "append"})
            self.assertTrue(result["verified"])
            self.assertEqual(result["backup_path"], str(backup))
            self.assertNotEqual(result["before_sha256"], result["after_sha256"])

            message = _restore(backup, source, before_hash)
            self.assertIn("hash-verified", message)
            self.assertEqual(source.read_bytes(), original)

    def test_word_edit_plan_requires_exact_bounded_replacement_count(self):
        self.assertEqual(_word_edit_args({"operation": "append", "content": "hello"})[:2], ("append", "hello"))
        plan = _word_edit_args({
            "operation": "replace_text",
            "find_text": "old",
            "content": "new",
            "expected_replacements": 2,
        })
        self.assertEqual(plan, ("replace_text", "new", "old", 2))
        with self.assertRaisesRegex(ToolError, "expected_replacements"):
            _word_edit_args({"operation": "replace_text", "find_text": "old", "content": "new"})
        with self.assertRaisesRegex(ToolError, "must differ"):
            _word_edit_args({"operation": "replace_text", "find_text": "same", "content": "same", "expected_replacements": 1})

    def test_excel_updates_are_single_cell_bounded_and_formula_safe(self):
        self.assertEqual(_validated_cell("$xfd$1048576"), "XFD1048576")
        with self.assertRaisesRegex(ToolError, "Invalid Excel cell"):
            _validated_cell("XFE1")
        with self.assertRaisesRegex(ToolError, "appears more than once"):
            _excel_updates({"updates": [{"cell": "A1", "value": 1}, {"cell": "$A$1", "value": 2}]})
        updates = _excel_updates({"updates": [{"cell": "b2", "value": "=WEBSERVICE(\"x\")", "expected_value": "old"}]})
        self.assertEqual(updates[0]["cell"], "B2")
        for value in ("=1+1", "+cmd", "-2+3", "@SUM(A1:A2)", "  =WEBSERVICE(\"x\")"):
            self.assertEqual(_excel_assignment(value), "'" + value)
        self.assertEqual(_excel_assignment("safe"), "safe")

    def test_powerpoint_edit_plan_is_bounded(self):
        self.assertEqual(
            _presentation_edit_args({"operation": "append_slide", "title": "Next", "bullets": ["One"]}),
            ("append_slide", None, "Next", ["One"]),
        )
        self.assertEqual(
            _presentation_edit_args({"operation": "update_slide", "slide_number": 3, "title": "Changed", "bullets": []}),
            ("update_slide", 3, "Changed", []),
        )
        with self.assertRaisesRegex(ToolError, "slide_number"):
            _presentation_edit_args({"operation": "update_slide", "title": "Missing", "bullets": []})
        with self.assertRaisesRegex(ToolError, "applies only"):
            _presentation_edit_args({"operation": "append_slide", "expected_title": "Old", "title": "New", "bullets": []})


if __name__ == "__main__":
    unittest.main()
