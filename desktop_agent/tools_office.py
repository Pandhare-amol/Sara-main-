"""Verified Microsoft Office workflows through the locally installed COM APIs.

These tools run only on Windows, never use macros, never overwrite by default,
and verify the resulting file on disk before reporting success. Generic UIA
remains available for unfamiliar dialogs; deterministic document operations use
Office's supported automation surface instead of fragile screen coordinates.
"""
from __future__ import annotations

import hashlib
import math
import os
import platform
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from xml.etree import ElementTree

from .registry import ToolError, register
from .tools_files import _ensure_safe, _resolve_file

_PROGIDS = {"word": "Word.Application", "excel": "Excel.Application", "powerpoint": "PowerPoint.Application"}
_MAX_EDIT_FILE_BYTES = 200 * 1024 * 1024
_CELL_ADDRESS = re.compile(r"^([A-Z]{1,3})([1-9][0-9]{0,6})$")
_CELL_RANGE = re.compile(r"^([A-Z]{1,3}[1-9][0-9]{0,6}):([A-Z]{1,3}[1-9][0-9]{0,6})$")
_SAFE_FORMULA_FUNCTIONS = {"SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "ROUND", "IF", "AND", "OR", "ABS", "SQRT"}
_CHART_TYPES = {"column": 51, "bar": 57, "line": 4, "pie": 5}  # Excel XlChartType values


def _require_windows() -> None:
    if platform.system() != "Windows":
        raise ToolError("Microsoft Office automation is available only on Windows.")


def _office_available(progid: str) -> bool:
    if platform.system() != "Windows":
        return False
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, progid + r"\CLSID"):
            return True
    except OSError:
        return False


def _dispatch(kind: str):
    _require_windows()
    progid = _PROGIDS[kind]
    if not _office_available(progid):
        raise ToolError(f"Microsoft {kind.title()} is not installed or its COM registration is unavailable.")
    try:
        import pythoncom
        import win32com.client
        pythoncom.CoInitialize()
        app = win32com.client.DispatchEx(progid)
        app.Visible = True
        if kind in {"word", "excel"}:
            app.DisplayAlerts = False
        # Documents handled here are Open XML, not macro-enabled formats, but
        # forcing Office's automation security to disable macros also protects
        # against an unexpected format/registration edge case.
        try:
            app.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
        except Exception:
            pass
        return app
    except Exception as exc:
        raise ToolError(f"Could not start Microsoft {kind.title()}: {exc}") from exc


def _destination(value: Any, extension: str) -> Path:
    path = _resolve_file(value)
    if path.suffix.lower() != extension:
        raise ToolError(f"Destination must end in {extension}.")
    _ensure_safe(path, False)
    if path.exists():
        raise ToolError(f"Destination already exists: {path}. Choose a new path; Office tools never overwrite silently.")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _safe_formula(value: Any) -> str:
    formula = str(value or "").strip()
    if not formula.startswith("=") or len(formula) > 1_000:
        raise ToolError("Each workbook formula must start with '=' and be at most 1,000 characters.")
    upper = formula.upper()
    if any(marker in upper for marker in ("[", "]", "HTTP:", "HTTPS:", "WEBSERVICE", "FILTERXML", "HYPERLINK", "RTD", "DDE", "|", "!")):
        raise ToolError("Workbook formulas cannot contain external workbook/sheet references, links, web/data functions or DDE syntax.")
    if not re.fullmatch(r"=[A-Za-z0-9_().,:+\-*/^%$<>=\s]+", formula):
        raise ToolError("Workbook formula contains unsupported characters. Use local arithmetic, cell/range references and approved functions only.")
    functions = {name.upper() for name in re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(", formula)}
    unsupported = sorted(functions - _SAFE_FORMULA_FUNCTIONS)
    if unsupported:
        raise ToolError(f"Workbook formula uses unsupported function(s): {', '.join(unsupported)}.")
    return formula


def _validate_pdf(source: Path) -> None:
    try:
        if source.stat().st_size < 16:
            raise ToolError("PDF export is unexpectedly small.")
        with source.open("rb") as handle:
            header = handle.read(8)
            handle.seek(max(0, source.stat().st_size - 2048))
            tail = handle.read()
        if not header.startswith(b"%PDF-") or b"%%EOF" not in tail:
            raise ToolError("Office produced a file that does not have a valid PDF signature/end marker.")
    except OSError as exc:
        raise ToolError("The exported PDF could not be read back for integrity verification.") from exc


def _validated_image(value: Any) -> Path:
    source = _resolve_file(value, must_exist=True)
    _ensure_safe(source, False)
    if source.suffix.casefold() not in {".png", ".jpg", ".jpeg", ".gif", ".bmp"}:
        raise ToolError("PowerPoint slide images must be local PNG, JPEG, GIF or BMP files.")
    if not source.is_file() or source.stat().st_size <= 0 or source.stat().st_size > 50 * 1024 * 1024:
        raise ToolError("PowerPoint slide image must be a non-empty local file no larger than 50 MB.")
    try:
        from PIL import Image
        with Image.open(source) as image:
            image.verify()
    except Exception as exc:
        raise ToolError(f"PowerPoint slide image is unreadable or corrupt: {source}") from exc
    return source


def _validate_open_xml(source: Path) -> None:
    """Reject malformed, macro/ActiveX, linked or zip-bomb-like packages."""
    try:
        with zipfile.ZipFile(source) as package:
            entries = package.infolist()
            names = {entry.filename.replace("\\", "/").lower() for entry in entries}
            if "[content_types].xml" not in names:
                raise ToolError("Office source is not a valid Open XML package.")
            if len(entries) > 20_000 or sum(entry.file_size for entry in entries) > 1024 * 1024 * 1024:
                raise ToolError("Office source expands beyond the bounded Open XML safety limits.")
            if any(name.endswith("vbaproject.bin") or "/activex/" in f"/{name}" for name in names):
                raise ToolError("Macro or ActiveX content is not accepted by deterministic Office edit tools.")
            for entry in entries:
                if not entry.filename.lower().endswith(".rels"):
                    continue
                if entry.file_size > 5 * 1024 * 1024:
                    raise ToolError(f"Office relationship metadata is unexpectedly large: {entry.filename}")
                try:
                    root = ElementTree.fromstring(package.read(entry))
                except ElementTree.ParseError as exc:
                    raise ToolError(f"Office relationship metadata is malformed: {entry.filename}") from exc
                for relationship in root:
                    if str(relationship.attrib.get("TargetMode", "")).lower() != "external":
                        continue
                    relationship_type = str(relationship.attrib.get("Type", "")).lower()
                    # Ordinary clickable hyperlinks do not update or fetch when
                    # Office opens the file. Linked templates/media/data can.
                    if not relationship_type.endswith("/hyperlink"):
                        raise ToolError(
                            "Office source contains linked external content. Convert links to embedded content before deterministic editing."
                        )
    except (zipfile.BadZipFile, RuntimeError, OSError) as exc:
        raise ToolError("Office source is not a readable, valid Open XML package.") from exc


def _readable_open_xml_source(value: Any, extensions: set[str]) -> Path:
    source = _resolve_file(value, must_exist=True)
    _ensure_safe(source, False)
    if not source.is_file():
        raise ToolError(f"Office source is not a file: {source}")
    if source.suffix.lower() not in extensions:
        allowed = ", ".join(sorted(extensions))
        raise ToolError(f"Office source must end in one of: {allowed}.")
    size = source.stat().st_size
    if size <= 0:
        raise ToolError(f"Office source is empty: {source}")
    if size > _MAX_EDIT_FILE_BYTES:
        raise ToolError("Office source exceeds the 200 MB safety limit.")
    if not os.access(source, os.R_OK):
        raise ToolError(f"Office source is not readable: {source}")
    _validate_open_xml(source)
    return source


def _editable_source(value: Any, extension: str) -> Path:
    source = _readable_open_xml_source(value, {extension})
    if source.suffix.lower() != extension:
        raise ToolError(f"Office edit source must end in {extension}.")
    if not os.access(source, os.W_OK):
        raise ToolError(f"Office source is not writable: {source}")
    return source


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _backup(source: Path) -> Tuple[Path, str]:
    """Create a same-folder, non-overwriting backup and verify its hash."""
    before_hash = _sha256(source)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = source.with_name(f"{source.stem}.sara-backup-{stamp}{source.suffix}")
    _ensure_safe(backup, False)
    if backup.exists():
        raise ToolError(f"Backup path already exists: {backup}")
    try:
        # Exclusive creation prevents a race from silently replacing a backup.
        with backup.open("xb") as target, source.open("rb") as original:
            shutil.copyfileobj(original, target, length=1024 * 1024)
        shutil.copystat(source, backup)
    except Exception as exc:
        try:
            if backup.exists():
                backup.unlink()
        except OSError:
            pass
        raise ToolError(f"Could not create the Office backup: {exc}") from exc
    if _sha256(backup) != before_hash or _sha256(source) != before_hash:
        try:
            backup.unlink()
        except OSError:
            pass
        raise ToolError("Office backup verification failed or the source changed during backup; the source was not opened.")
    return backup, before_hash


def _restore(backup: Path, source: Path, before_hash: str) -> str:
    try:
        shutil.copy2(backup, source)
        if _sha256(source) != before_hash:
            return "The backup was copied back, but hash verification failed. Inspect both files before continuing."
        return "The original was restored and hash-verified from the backup."
    except Exception as exc:
        return f"Automatic restore failed ({exc}). The verified backup remains at {backup}."


def _verified_edit(
    source: Path,
    backup: Path,
    before_hash: str,
    kind: str,
    detail: Dict[str, Any],
) -> Dict[str, Any]:
    if not source.is_file() or source.stat().st_size <= 0:
        raise ToolError(f"Office reported success but {source.name} is missing or empty.")
    if not backup.is_file() or _sha256(backup) != before_hash:
        raise ToolError("The Office edit completed, but its backup could not be verified. Stop and inspect both files.")
    after_hash = _sha256(source)
    if after_hash == before_hash:
        raise ToolError("Office did not produce a changed file. The original and backup are unchanged.")
    return {
        "result": f"Updated and verified {source.name} in Microsoft {kind.title()}; kept an automatic backup.",
        "path": str(source),
        "backup_path": str(backup),
        "size": source.stat().st_size,
        "application": kind,
        "verified": True,
        "verification": "backup_hash_and_post_edit_content",
        "before_sha256": before_hash,
        "after_sha256": after_hash,
        **detail,
    }


def _close_item(kind: str, item: Any, app: Any) -> None:
    try:
        if item is not None:
            if kind in {"word", "excel"}:
                item.Close(False)
            else:
                item.Close()
        if app is not None:
            app.Quit()
    except Exception:
        pass


def _verified(path: Path, kind: str, detail: Dict[str, Any]) -> Dict[str, Any]:
    if not path.is_file() or path.stat().st_size <= 0:
        raise ToolError(f"Office reported success but {path.name} was not created correctly.")
    if path.suffix.casefold() in {".docx", ".xlsx", ".pptx"}:
        _validate_open_xml(path)
        verification = "file_exists_nonempty_and_valid_open_xml"
    elif path.suffix.casefold() == ".pdf":
        _validate_pdf(path)
        verification = "file_exists_nonempty_and_valid_pdf_signature"
    else:
        verification = "file_exists_and_nonempty"
    return {
        "result": f"Created and verified {path.name} in Microsoft {kind.title()}.",
        "path": str(path), "size": path.stat().st_size, "sha256": _sha256(path), "application": kind,
        "verified": True, "verification": verification, **detail,
    }


@register("officeStatus")
def office_status(_args: Dict[str, Any]) -> Dict[str, Any]:
    apps = {kind: _office_available(progid) for kind, progid in _PROGIDS.items()}
    return {"result": "Checked local Microsoft Office availability.", "windows": platform.system() == "Windows", "applications": apps}


@register("officeCreateWord")
def office_create_word(args: Dict[str, Any]) -> Dict[str, Any]:
    destination = _destination(args.get("path"), ".docx")
    content = str(args.get("content") or "")
    if len(content) > 500_000:
        raise ToolError("Word content exceeds the 500,000 character limit.")
    app = _dispatch("word")
    doc = None
    try:
        doc = app.Documents.Add()
        title = str(args.get("title") or "").strip()
        if title:
            paragraph = doc.Paragraphs.Add()
            paragraph.Range.Text = title
            paragraph.Range.Style = "Title"
            paragraph.Range.InsertParagraphAfter()
        doc.Content.InsertAfter(content)
        doc.SaveAs2(str(destination), FileFormat=12)  # wdFormatXMLDocument
        doc.Saved = True
        return _verified(destination, "word", {"characters": len(content), "title": title})
    except Exception as exc:
        try:
            if destination.exists(): destination.unlink()
        except OSError:
            pass
        raise ToolError(f"Microsoft Word could not create the document: {exc}") from exc
    finally:
        # Keep the successfully created document visible for the user. On
        # failure close the transient blank document and app.
        if not destination.exists():
            try:
                if doc is not None: doc.Close(False)
                app.Quit()
            except Exception:
                pass


@register("officeCreateWorkbook")
def office_create_workbook(args: Dict[str, Any]) -> Dict[str, Any]:
    destination = _destination(args.get("path"), ".xlsx")
    rows = args.get("rows") or []
    formulas = args.get("formulas") or []
    charts = args.get("charts") or []
    if not isinstance(rows, list) or any(not isinstance(row, list) for row in rows):
        raise ToolError("rows must be a two-dimensional array.")
    if len(rows) > 10_000 or sum(len(row) for row in rows) > 100_000:
        raise ToolError("Workbook data exceeds the 100,000 cell safety limit.")
    if not isinstance(formulas, list) or len(formulas) > 2_000 or any(not isinstance(item, dict) for item in formulas):
        raise ToolError("formulas must be an array with at most 2,000 explicit formula cells.")
    if not isinstance(charts, list) or len(charts) > 20 or any(not isinstance(item, dict) for item in charts):
        raise ToolError("charts must be an array with at most 20 chart definitions.")
    normalized_formulas: List[Dict[str, str]] = []
    seen_formula_cells: set[str] = set()
    for item in formulas:
        cell = str(item.get("cell") or "").strip().upper()
        if not _CELL_ADDRESS.fullmatch(cell) or cell in seen_formula_cells:
            raise ToolError(f"Formula cell must be one unique A1 address: {cell or '(missing)' }.")
        seen_formula_cells.add(cell)
        normalized_formulas.append({
            "cell": cell,
            "formula": _safe_formula(item.get("formula")),
            "number_format": str(item.get("number_format") or "").strip()[:80],
        })
    normalized_charts: List[Dict[str, Any]] = []
    for item in charts:
        chart_type = str(item.get("type") or "column").strip().casefold()
        source_range = str(item.get("source_range") or "").strip().upper()
        anchor = str(item.get("anchor_cell") or "F2").strip().upper()
        if chart_type not in _CHART_TYPES:
            raise ToolError("Chart type must be column, bar, line or pie.")
        if not _CELL_RANGE.fullmatch(source_range):
            raise ToolError(f"Chart source_range must be one local A1 range such as A1:B6: {source_range or '(missing)' }.")
        if not _CELL_ADDRESS.fullmatch(anchor):
            raise ToolError(f"Chart anchor_cell must be one A1 address: {anchor}.")
        normalized_charts.append({
            "type": chart_type,
            "source_range": source_range,
            "anchor_cell": anchor,
            "title": str(item.get("title") or "")[:300],
        })
    app = _dispatch("excel")
    workbook = None
    try:
        workbook = app.Workbooks.Add()
        sheet = workbook.Worksheets(1)
        name = str(args.get("sheet_name") or "Sheet1").strip()[:31]
        if name:
            sheet.Name = name
        for row_index, row in enumerate(rows, 1):
            for column_index, value in enumerate(row, 1):
                # Ordinary values are always values. Formula execution is
                # available only through the separately validated formulas
                # array so imported/user data cannot become executable cells.
                if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
                    value = "'" + value
                sheet.Cells(row_index, column_index).Value = value
        if args.get("header") and rows:
            sheet.Range(sheet.Cells(1, 1), sheet.Cells(1, len(rows[0]))).Font.Bold = True
        for formula in normalized_formulas:
            target = sheet.Range(formula["cell"])
            target.Formula = formula["formula"]
            if formula["number_format"]:
                target.NumberFormat = formula["number_format"]
        try:
            app.CalculateFull()
        except Exception:
            try:
                workbook.Application.Calculate()
            except Exception:
                pass
        formula_results: List[Dict[str, Any]] = []
        for formula in normalized_formulas:
            value = sheet.Range(formula["cell"]).Value
            if isinstance(value, float) and not math.isfinite(value):
                raise ToolError(f"Formula {formula['cell']} produced a non-finite result.")
            if isinstance(value, str) and value.startswith("#"):
                raise ToolError(f"Formula {formula['cell']} produced Excel error {value}.")
            formula_results.append({"cell": formula["cell"], "formula": formula["formula"], "value": value})
        for chart in normalized_charts:
            anchor = sheet.Range(chart["anchor_cell"])
            chart_object = sheet.ChartObjects().Add(float(anchor.Left), float(anchor.Top), 480.0, 280.0)
            excel_chart = chart_object.Chart
            excel_chart.ChartType = _CHART_TYPES[chart["type"]]
            excel_chart.SetSourceData(sheet.Range(chart["source_range"]))
            if chart["title"]:
                excel_chart.HasTitle = True
                excel_chart.ChartTitle.Text = chart["title"]
        sheet.UsedRange.Columns.AutoFit()
        workbook.SaveAs(str(destination), FileFormat=51)  # xlOpenXMLWorkbook
        workbook.Saved = True
        return _verified(destination, "excel", {
            "rows": len(rows), "cells": sum(len(row) for row in rows), "sheet": name,
            "formulas": len(normalized_formulas), "formula_results": formula_results,
            "charts": len(normalized_charts),
        })
    except Exception as exc:
        try:
            if destination.exists(): destination.unlink()
        except OSError:
            pass
        if isinstance(exc, ToolError):
            raise
        raise ToolError(f"Microsoft Excel could not create the workbook: {exc}") from exc
    finally:
        if not destination.exists():
            try:
                if workbook is not None: workbook.Close(False)
                app.Quit()
            except Exception:
                pass


@register("officeCreatePresentation")
def office_create_presentation(args: Dict[str, Any]) -> Dict[str, Any]:
    destination = _destination(args.get("path"), ".pptx")
    slides = args.get("slides") or []
    if not isinstance(slides, list) or len(slides) > 200:
        raise ToolError("slides must be an array with at most 200 entries.")
    normalized: List[Dict[str, Any]] = []
    for index, item in enumerate(slides, 1):
        if not isinstance(item, dict):
            raise ToolError(f"Slide {index} must be an object with title and bullets.")
        bullets = item.get("bullets") or []
        if not isinstance(bullets, list) or len(bullets) > 50:
            raise ToolError(f"Slide {index} bullets must be an array with at most 50 entries.")
        image = _validated_image(item.get("image_path")) if item.get("image_path") else None
        normalized.append({
            "title": str(item.get("title") or "")[:500],
            "bullets": [str(value)[:2_000] for value in bullets],
            "image": image,
        })
    app = _dispatch("powerpoint")
    presentation = None
    try:
        presentation = app.Presentations.Add()
        embedded_images = 0
        for index, item in enumerate(normalized, 1):
            slide = presentation.Slides.Add(index, 2)  # ppLayoutText: editable title + body
            title_shape = slide.Shapes.Title
            body_shape = slide.Shapes.Placeholders(2)
            title_shape.TextFrame.TextRange.Text = item["title"]
            body_shape.TextFrame.TextRange.Text = "\r".join(item["bullets"])
            try:
                title_shape.TextFrame.TextRange.Font.Size = 28
                body_shape.TextFrame.TextRange.Font.Size = 18
            except Exception:
                pass
            image = item["image"]
            if image is not None:
                # Keep both text and visual editable/embedded. The image is
                # copied into the PPTX (LinkToFile=False, SaveWithDocument=True).
                slide_width = float(presentation.PageSetup.SlideWidth)
                slide_height = float(presentation.PageSetup.SlideHeight)
                body_shape.Left = 36.0
                body_shape.Width = slide_width * 0.46
                body_shape.Top = 105.0
                body_shape.Height = max(120.0, slide_height - 140.0)
                slide.Shapes.AddPicture(
                    str(image), False, True,
                    slide_width * 0.54, 110.0,
                    slide_width * 0.42, max(120.0, slide_height - 155.0),
                )
                embedded_images += 1
        presentation.SaveAs(str(destination), 24)  # ppSaveAsOpenXMLPresentation
        presentation.Saved = True
        return _verified(destination, "powerpoint", {"slides": len(slides), "embedded_images": embedded_images, "editable_text": True})
    except Exception as exc:
        try:
            if destination.exists(): destination.unlink()
        except OSError:
            pass
        if isinstance(exc, ToolError):
            raise
        raise ToolError(f"Microsoft PowerPoint could not create the presentation: {exc}") from exc
    finally:
        if not destination.exists():
            try:
                if presentation is not None: presentation.Close()
                app.Quit()
            except Exception:
                pass


def _word_edit_args(args: Dict[str, Any]) -> Tuple[str, str, Optional[str], Optional[int]]:
    operation = str(args.get("operation") or "").strip().lower()
    if operation not in {"append", "replace_text"}:
        raise ToolError("Word edit operation must be append or replace_text.")
    content = str(args.get("content") or "")
    if not content:
        raise ToolError("Word edit content cannot be empty.")
    if len(content) > 100_000:
        raise ToolError("One Word edit is limited to 100,000 characters.")
    find_text: Optional[str] = None
    expected: Optional[int] = None
    if operation == "replace_text":
        find_text = str(args.get("find_text") or "")
        if not find_text:
            raise ToolError("find_text is required for replace_text.")
        if len(find_text) > 50_000:
            raise ToolError("Word find_text exceeds the 50,000 character limit.")
        if find_text == content:
            raise ToolError("Word replacement must differ from find_text.")
        try:
            expected = int(args.get("expected_replacements"))
        except (TypeError, ValueError):
            raise ToolError("expected_replacements is required for replace_text.")
        if expected < 1 or expected > 1_000:
            raise ToolError("expected_replacements must be between 1 and 1,000.")
    return operation, content, find_text, expected


@register("officeEditWord")
def office_edit_word(args: Dict[str, Any]) -> Dict[str, Any]:
    source = _editable_source(args.get("path"), ".docx")
    operation, content, find_text, expected = _word_edit_args(args)
    app = _dispatch("word")
    doc = None
    backup = None
    before_hash = ""
    success = False
    try:
        backup, before_hash = _backup(source)
        doc = app.Documents.Open(str(source), ReadOnly=False, AddToRecentFiles=False, UpdateLinks=0)
        if bool(getattr(doc, "ReadOnly", False)):
            raise ToolError("Word opened the document read-only; no change was made.")
        replacements = 0
        before_text = str(doc.Content.Text)
        expected_text: Optional[str] = None
        if operation == "append":
            doc.Content.InsertAfter(content)
        else:
            replacements = before_text.count(find_text)
            if replacements != expected:
                raise ToolError(
                    f"Word found {replacements} exact occurrence(s), not the approved {expected}; no change was saved."
                )
            search_range = doc.Content.Duplicate
            applied = 0
            while applied < expected:
                changed = search_range.Find.Execute(
                    FindText=find_text,
                    MatchCase=True,
                    MatchWholeWord=False,
                    MatchWildcards=False,
                    Forward=True,
                    Wrap=0,  # wdFindStop
                    Format=False,
                )
                if not changed:
                    break
                if str(search_range.Text) != find_text:
                    raise ToolError("Word's search did not resolve to the exact approved text; no change was saved.")
                search_range.Text = content
                applied += 1
                search_range.SetRange(search_range.End, doc.Content.End)
            if applied != expected:
                raise ToolError(f"Word applied {applied} of {expected} approved replacement(s); the original will be restored.")
            expected_text = before_text.replace(find_text, content)
        after_text = str(doc.Content.Text)
        if operation == "append" and not after_text.endswith(content):
            raise ToolError("Word could not verify the appended text; the original will be restored.")
        if operation == "replace_text" and after_text != expected_text:
            raise ToolError("Word's document text does not match the approved replacement; the original will be restored.")
        doc.Save()
        doc.Saved = True
        result = _verified_edit(source, backup, before_hash, "word", {
            "operation": operation,
            "characters": len(content),
            "replacements": replacements,
        })
        success = True
        return result
    except Exception as exc:
        _close_item("word", doc, app)
        doc = None
        app = None
        restore = _restore(backup, source, before_hash) if backup is not None else "No backup was created and the source was not opened."
        if isinstance(exc, ToolError):
            raise ToolError(f"{exc} {restore}") from exc
        raise ToolError(f"Microsoft Word could not update the document: {exc}. {restore}") from exc
    finally:
        # A successful edit remains visible to the user; failed edits are
        # closed before the verified backup is restored.
        if not success:
            _close_item("word", doc, app)


def _column_number(letters: str) -> int:
    value = 0
    for letter in letters:
        value = value * 26 + (ord(letter) - ord("A") + 1)
    return value


def _validated_cell(value: Any) -> str:
    address = str(value or "").strip().upper().replace("$", "")
    match = _CELL_ADDRESS.fullmatch(address)
    if not match or _column_number(match.group(1)) > 16_384 or int(match.group(2)) > 1_048_576:
        raise ToolError(f"Invalid Excel cell address '{value}'. Use one cell from A1 through XFD1048576.")
    return address


def _excel_updates(args: Dict[str, Any]) -> List[Dict[str, Any]]:
    updates = args.get("updates")
    if not isinstance(updates, list) or not updates or len(updates) > 1_000:
        raise ToolError("Excel updates must contain between 1 and 1,000 cell updates.")
    seen = set()
    output: List[Dict[str, Any]] = []
    for index, item in enumerate(updates, 1):
        if not isinstance(item, dict) or "value" not in item:
            raise ToolError(f"Excel update {index} must contain cell and value.")
        address = _validated_cell(item.get("cell"))
        if address in seen:
            raise ToolError(f"Excel cell {address} appears more than once in one edit.")
        seen.add(address)
        value = item.get("value")
        if value is not None and not isinstance(value, (str, int, float, bool)):
            raise ToolError(f"Excel value for {address} must be text, number, boolean or null.")
        if isinstance(value, float) and not math.isfinite(value):
            raise ToolError(f"Excel value for {address} must be finite.")
        if isinstance(value, str) and len(value) > 32_767:
            raise ToolError(f"Excel value for {address} exceeds the 32,767 character cell limit.")
        if "expected_value" in item:
            expected_value = item["expected_value"]
            if expected_value is not None and not isinstance(expected_value, (str, int, float, bool)):
                raise ToolError(f"Excel expected_value for {address} must be text, number, boolean or null.")
            if isinstance(expected_value, float) and not math.isfinite(expected_value):
                raise ToolError(f"Excel expected_value for {address} must be finite.")
            if isinstance(expected_value, str) and len(expected_value) > 32_767:
                raise ToolError(f"Excel expected_value for {address} exceeds the 32,767 character cell limit.")
        output.append({"cell": address, "value": value, **({"expected_value": item["expected_value"]} if "expected_value" in item else {})})
    return output


def _excel_assignment(value: Any) -> Any:
    # Apostrophe forces a literal value and is not displayed in Excel. This
    # blocks formula/DDE/external-data execution for model- or document-supplied
    # strings, including the less obvious +, -, and @ prefixes.
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def _same_value(actual: Any, expected: Any) -> bool:
    if actual is None or expected is None:
        return actual is None and expected is None
    if isinstance(expected, bool):
        return bool(actual) is expected
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        try:
            return float(actual) == float(expected)
        except (TypeError, ValueError):
            return False
    return str(actual) == str(expected)


@register("officeEditWorkbook")
def office_edit_workbook(args: Dict[str, Any]) -> Dict[str, Any]:
    source = _editable_source(args.get("path"), ".xlsx")
    sheet_name = str(args.get("sheet_name") or "").strip()
    if not sheet_name or len(sheet_name) > 31:
        raise ToolError("sheet_name is required and limited to 31 characters.")
    updates = _excel_updates(args)
    app = _dispatch("excel")
    workbook = None
    backup = None
    before_hash = ""
    success = False
    try:
        backup, before_hash = _backup(source)
        workbook = app.Workbooks.Open(
            str(source), UpdateLinks=0, ReadOnly=False, IgnoreReadOnlyRecommended=True,
        )
        if bool(getattr(workbook, "ReadOnly", False)):
            raise ToolError("Excel opened the workbook read-only; no change was made.")
        try:
            sheet = workbook.Worksheets(sheet_name)
        except Exception as exc:
            raise ToolError(f"Worksheet '{sheet_name}' does not exist; no change was made.") from exc

        pending: List[Tuple[Any, Dict[str, Any], Any]] = []
        for update in updates:
            cell = sheet.Range(update["cell"])
            old_value = cell.Value2
            if "expected_value" in update and not _same_value(old_value, update["expected_value"]):
                raise ToolError(
                    f"Excel {sheet_name}!{update['cell']} no longer has the expected value; no change was saved."
                )
            pending.append((cell, update, old_value))
        if all(_same_value(old, update["value"]) for _, update, old in pending):
            raise ToolError("Every requested Excel cell already has the approved value; no edit is needed.")

        for cell, update, _old in pending:
            # Use Value (as in workbook creation) so Excel consumes the leading
            # apostrophe as a text marker rather than storing it as content.
            cell.Value = _excel_assignment(update["value"])
        workbook.Save()
        workbook.Saved = True
        for cell, update, _old in pending:
            if not _same_value(cell.Value2, update["value"]):
                raise ToolError(f"Excel could not verify the saved value in {sheet_name}!{update['cell']}.")
        result = _verified_edit(source, backup, before_hash, "excel", {
            "sheet": sheet_name,
            "cells_updated": len(updates),
            "cells": [update["cell"] for update in updates],
        })
        success = True
        return result
    except Exception as exc:
        _close_item("excel", workbook, app)
        workbook = None
        app = None
        restore = _restore(backup, source, before_hash) if backup is not None else "No backup was created and the source was not opened."
        if isinstance(exc, ToolError):
            raise ToolError(f"{exc} {restore}") from exc
        raise ToolError(f"Microsoft Excel could not update the workbook: {exc}. {restore}") from exc
    finally:
        if not success:
            _close_item("excel", workbook, app)


def _presentation_edit_args(args: Dict[str, Any]) -> Tuple[str, Optional[int], str, List[str]]:
    operation = str(args.get("operation") or "").strip().lower()
    if operation not in {"append_slide", "update_slide"}:
        raise ToolError("PowerPoint edit operation must be append_slide or update_slide.")
    title = str(args.get("title") or "")
    if len(title) > 500:
        raise ToolError("PowerPoint title exceeds 500 characters.")
    raw_bullets = args.get("bullets") or []
    if not isinstance(raw_bullets, list) or len(raw_bullets) > 50:
        raise ToolError("PowerPoint bullets must be an array with at most 50 entries.")
    bullets = [str(value) for value in raw_bullets]
    if any(len(value) > 2_000 for value in bullets):
        raise ToolError("A PowerPoint bullet exceeds 2,000 characters.")
    slide_number: Optional[int] = None
    if operation == "update_slide":
        try:
            slide_number = int(args.get("slide_number"))
        except (TypeError, ValueError):
            raise ToolError("slide_number is required for update_slide.")
        if slide_number < 1 or slide_number > 200:
            raise ToolError("slide_number must be between 1 and 200.")
    expected_title = args.get("expected_title")
    if expected_title is not None and (not isinstance(expected_title, str) or len(expected_title) > 500):
        raise ToolError("PowerPoint expected_title must be text of at most 500 characters when provided.")
    if operation == "append_slide" and expected_title is not None:
        raise ToolError("expected_title applies only to update_slide.")
    return operation, slide_number, title, bullets


def _slide_text_shapes(slide: Any) -> Tuple[Any, Any]:
    title_shape = slide.Shapes.Title
    if title_shape is None:
        raise ToolError("The target slide has no editable title placeholder.")
    body = None
    try:
        body = slide.Shapes.Placeholders(2)
    except Exception:
        # Some templates renumber placeholders. Use the first non-title text
        # shape, but never delete pictures, charts or other slide content.
        title_name = str(getattr(title_shape, "Name", ""))
        for index in range(1, int(slide.Shapes.Count) + 1):
            candidate = slide.Shapes(index)
            if str(getattr(candidate, "Name", "")) == title_name:
                continue
            if bool(getattr(candidate, "HasTextFrame", False)):
                body = candidate
                break
    if body is None:
        raise ToolError("The target slide has no editable body text placeholder.")
    return title_shape, body


def _set_slide_text(slide: Any, title: str, bullets: List[str]) -> Tuple[Any, Any]:
    title_shape, body = _slide_text_shapes(slide)
    title_shape.TextFrame.TextRange.Text = title
    body.TextFrame.TextRange.Text = "\r".join(bullets)
    return title_shape, body


@register("officeEditPresentation")
def office_edit_presentation(args: Dict[str, Any]) -> Dict[str, Any]:
    source = _editable_source(args.get("path"), ".pptx")
    operation, slide_number, title, bullets = _presentation_edit_args(args)
    expected_title = args.get("expected_title")
    app = _dispatch("powerpoint")
    presentation = None
    backup = None
    before_hash = ""
    success = False
    try:
        backup, before_hash = _backup(source)
        presentation = app.Presentations.Open(str(source), ReadOnly=False, Untitled=False, WithWindow=True)
        if bool(getattr(presentation, "ReadOnly", False)):
            raise ToolError("PowerPoint opened the presentation read-only; no change was made.")
        if operation == "append_slide":
            if int(presentation.Slides.Count) >= 200:
                raise ToolError("Presentation already has 200 slides; the safety limit prevents adding another.")
            slide_number = int(presentation.Slides.Count) + 1
            slide = presentation.Slides.Add(slide_number, 2)  # ppLayoutText
        else:
            if slide_number is None or slide_number > int(presentation.Slides.Count):
                raise ToolError(f"Slide {slide_number} does not exist; no change was made.")
            slide = presentation.Slides(slide_number)
            old_title_shape, old_body_shape = _slide_text_shapes(slide)
            old_title = str(old_title_shape.TextFrame.TextRange.Text)
            old_body = str(old_body_shape.TextFrame.TextRange.Text)
            if expected_title is not None and old_title != expected_title:
                raise ToolError(f"Slide {slide_number}'s title no longer matches expected_title; no change was saved.")
            if old_title == title and old_body == "\r".join(bullets):
                raise ToolError(f"Slide {slide_number} already has the approved title and bullets; no edit is needed.")
        title_shape, body_shape = _set_slide_text(slide, title, bullets)
        presentation.Save()
        presentation.Saved = True
        if str(title_shape.TextFrame.TextRange.Text) != title or str(body_shape.TextFrame.TextRange.Text) != "\r".join(bullets):
            raise ToolError(f"PowerPoint could not verify slide {slide_number}'s saved title and body text.")
        result = _verified_edit(source, backup, before_hash, "powerpoint", {
            "operation": operation,
            "slide": slide_number,
            "bullets": len(bullets),
        })
        success = True
        return result
    except Exception as exc:
        _close_item("powerpoint", presentation, app)
        presentation = None
        app = None
        restore = _restore(backup, source, before_hash) if backup is not None else "No backup was created and the source was not opened."
        if isinstance(exc, ToolError):
            raise ToolError(f"{exc} {restore}") from exc
        raise ToolError(f"Microsoft PowerPoint could not update the presentation: {exc}. {restore}") from exc
    finally:
        if not success:
            _close_item("powerpoint", presentation, app)


@register("officeExportPdf")
def office_export_pdf(args: Dict[str, Any]) -> Dict[str, Any]:
    source = _readable_open_xml_source(args.get("path"), {".docx", ".xlsx", ".pptx"})
    destination = _destination(args.get("destination"), ".pdf")
    suffix = source.suffix.lower()
    app = None
    item = None
    try:
        if suffix == ".docx":
            app = _dispatch("word"); item = app.Documents.Open(str(source), ReadOnly=True, AddToRecentFiles=False, UpdateLinks=0); item.ExportAsFixedFormat(str(destination), 17)
        elif suffix == ".xlsx":
            app = _dispatch("excel"); item = app.Workbooks.Open(str(source), ReadOnly=True); item.ExportAsFixedFormat(0, str(destination))
        elif suffix == ".pptx":
            app = _dispatch("powerpoint"); item = app.Presentations.Open(str(source), WithWindow=True); item.SaveAs(str(destination), 32)
        else:
            raise ToolError("PDF export supports .docx, .xlsx and .pptx sources.")
        return _verified(destination, {".docx": "word", ".xlsx": "excel", ".pptx": "powerpoint"}[suffix], {"source": str(source), "exported": True})
    except ToolError:
        raise
    except Exception as exc:
        try:
            if destination.exists(): destination.unlink()
        except OSError:
            pass
        raise ToolError(f"Office PDF export failed: {exc}") from exc
    finally:
        try:
            if item is not None:
                if suffix == ".docx": item.Close(False)
                elif suffix == ".xlsx": item.Close(False)
                else: item.Close()
            if app is not None: app.Quit()
        except Exception:
            pass


__all__ = [
    "office_status",
    "office_create_word",
    "office_create_workbook",
    "office_create_presentation",
    "office_edit_word",
    "office_edit_workbook",
    "office_edit_presentation",
    "office_export_pdf",
]
