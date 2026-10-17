import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from desktop_agent.registry import DESKTOP_TOOL_NAMES, TOOLS, ToolError
from desktop_agent.tools_files import create_file
from desktop_agent.tools_office import (
    _backup,
    _destination,
    _editable_source,
    _excel_assignment,
    _excel_updates,
    _presentation_edit_args,
    _restore,
    _safe_formula,
    _sha256,
    _validate_pdf,
    _validated_cell,
    _verified_edit,
    _word_edit_args,
    office_create_presentation,
    office_create_workbook,
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

    def test_text_file_primitive_rejects_fake_binary_artifacts(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
            for extension in ("png", "pdf", "docx", "xlsx", "pptx"):
                with self.assertRaisesRegex(ToolError, "cannot create a real"):
                    create_file({"path": str(Path(directory) / f"fake.{extension}"), "content": "plain text"})
            result = create_file({"path": str(Path(directory) / "real.md"), "content": "# Real text"})
            self.assertTrue(Path(result["path"]).is_file())

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

    def test_explicit_creation_formulas_are_local_and_allowlisted(self):
        self.assertEqual(_safe_formula("=B2*C2"), "=B2*C2")
        self.assertEqual(_safe_formula("=SUM(D2:D10)"), "=SUM(D2:D10)")
        for unsafe in (
            "=WEBSERVICE(A1)",
            "=HYPERLINK(A1)",
            "=[other.xlsx]Sheet1!A1",
            "='https://example.invalid/data'!A1",
        ):
            with self.assertRaises(ToolError):
                _safe_formula(unsafe)

    def test_workbook_creation_applies_formula_and_chart_then_verifies_package(self):
        class Cell:
            def __init__(self):
                self.Value = None
                self.Formula = None
                self.NumberFormat = None
                self.Left = 300
                self.Top = 40

        class Range:
            def __init__(self, cell=None):
                self.cell = cell
                self.Font = type("Font", (), {"Bold": False})()
            @property
            def Value(self):
                return self.cell.Value if self.cell else None
            @Value.setter
            def Value(self, value):
                self.cell.Value = value
            @property
            def Formula(self):
                return self.cell.Formula
            @Formula.setter
            def Formula(self, value):
                self.cell.Formula = value
                self.cell.Value = 20
            @property
            def NumberFormat(self):
                return self.cell.NumberFormat
            @NumberFormat.setter
            def NumberFormat(self, value):
                self.cell.NumberFormat = value
            @property
            def Left(self): return self.cell.Left
            @property
            def Top(self): return self.cell.Top

        class Chart:
            def __init__(self):
                self.ChartType = None
                self.HasTitle = False
                self.ChartTitle = type("Title", (), {"Text": ""})()
                self.source = None
            def SetSourceData(self, source): self.source = source

        class Sheet:
            def __init__(self):
                self.Name = "Sheet1"
                self.cells = {}
                self.chart = Chart()
                self.UsedRange = type("Used", (), {"Columns": type("Cols", (), {"AutoFit": lambda _self: None})()})()
            def Cells(self, row, column):
                return self.cells.setdefault((row, column), Cell())
            def Range(self, *args):
                if len(args) == 1 and isinstance(args[0], str):
                    if ":" in args[0]: return Range()
                    match = __import__("re").fullmatch(r"([A-Z]+)(\d+)", args[0])
                    column = 0
                    for char in match.group(1): column = column * 26 + ord(char) - 64
                    return Range(self.Cells(int(match.group(2)), column))
                return Range()
            def ChartObjects(self):
                chart = self.chart
                return type("Charts", (), {"Add": lambda _self, *_args: type("Object", (), {"Chart": chart})()})()

        class Workbook:
            def __init__(self, destination):
                self.sheet = Sheet()
                self.Worksheets = lambda _index: self.sheet
                self.Saved = False
                self.destination = destination
            def SaveAs(self, destination, FileFormat):
                self.assert_format = FileFormat
                _open_xml_fixture(Path(destination))

        with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
            destination = Path(directory) / "calculated.xlsx"
            workbook = Workbook(destination)
            app = type("Excel", (), {
                "Workbooks": type("Books", (), {"Add": lambda _self: workbook})(),
                "CalculateFull": lambda _self: None,
            })()
            with patch("desktop_agent.tools_office._dispatch", return_value=app):
                result = office_create_workbook({
                    "path": str(destination),
                    "sheet_name": "Summary",
                    "rows": [["Units", "Price"], [2, 10]],
                    "header": True,
                    "formulas": [{"cell": "C2", "formula": "=A2*B2", "number_format": "0.00"}],
                    "charts": [{"type": "column", "source_range": "A1:B2", "anchor_cell": "E2", "title": "Values"}],
                })
            self.assertTrue(result["verified"])
            self.assertEqual(result["formula_results"], [{"cell": "C2", "formula": "=A2*B2", "value": 20}])
            self.assertEqual(result["charts"], 1)
            self.assertEqual(workbook.sheet.chart.ChartType, 51)
            self.assertEqual(workbook.sheet.chart.ChartTitle.Text, "Values")

    def test_presentation_creation_keeps_editable_text_and_embeds_valid_image(self):
        class TextRange:
            def __init__(self):
                self.Text = ""
                self.Font = type("Font", (), {"Size": None})()
        class Shape:
            def __init__(self):
                self.TextFrame = type("Frame", (), {"TextRange": TextRange()})()
                self.Left = self.Top = self.Width = self.Height = 0
        class Shapes:
            def __init__(self):
                self.Title = Shape()
                self.body = Shape()
                self.pictures = []
            def Placeholders(self, _index): return self.body
            def AddPicture(self, *args): self.pictures.append(args)
        class Slides:
            def __init__(self): self.items = []
            def Add(self, _index, _layout):
                slide = type("Slide", (), {"Shapes": Shapes()})()
                self.items.append(slide)
                return slide
        class Presentation:
            def __init__(self):
                self.Slides = Slides()
                self.PageSetup = type("Page", (), {"SlideWidth": 960, "SlideHeight": 540})()
                self.Saved = False
            def SaveAs(self, destination, _format): _open_xml_fixture(Path(destination))

        with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
            from PIL import Image
            image = Path(directory) / "chart.png"
            Image.new("RGB", (20, 10), "blue").save(image)
            destination = Path(directory) / "brief.pptx"
            presentation = Presentation()
            app = type("PowerPoint", (), {"Presentations": type("Presentations", (), {"Add": lambda _self: presentation})()})()
            with patch("desktop_agent.tools_office._dispatch", return_value=app):
                result = office_create_presentation({
                    "path": str(destination),
                    "slides": [{"title": "Summary", "bullets": ["Editable evidence"], "image_path": str(image)}],
                })
            slide = presentation.Slides.items[0]
            self.assertTrue(result["verified"])
            self.assertTrue(result["editable_text"])
            self.assertEqual(result["embedded_images"], 1)
            self.assertEqual(slide.Shapes.Title.TextFrame.TextRange.Text, "Summary")
            self.assertEqual(slide.Shapes.body.TextFrame.TextRange.Text, "Editable evidence")
            self.assertEqual(slide.Shapes.pictures[0][1:3], (False, True))

    def test_pdf_integrity_check_rejects_text_with_pdf_extension(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
            fake = Path(directory) / "fake.pdf"
            fake.write_text("not really a PDF", encoding="utf-8")
            with self.assertRaisesRegex(ToolError, "PDF signature"):
                _validate_pdf(fake)
            valid_minimum = Path(directory) / "minimal.pdf"
            valid_minimum.write_bytes(b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n")
            _validate_pdf(valid_minimum)

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
