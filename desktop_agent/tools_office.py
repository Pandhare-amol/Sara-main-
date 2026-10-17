"""Verified Microsoft Office workflows through the locally installed COM APIs.

These tools run only on Windows, never use macros, never overwrite by default,
and verify the resulting file on disk before reporting success. Generic UIA
remains available for unfamiliar dialogs; deterministic document operations use
Office's supported automation surface instead of fragile screen coordinates.
"""
from __future__ import annotations

import os
import platform
from pathlib import Path
from typing import Any, Dict, List

from .registry import ToolError, register
from .tools_files import _ensure_safe, _resolve_file

_PROGIDS = {"word": "Word.Application", "excel": "Excel.Application", "powerpoint": "PowerPoint.Application"}


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


def _verified(path: Path, kind: str, detail: Dict[str, Any]) -> Dict[str, Any]:
    if not path.is_file() or path.stat().st_size <= 0:
        raise ToolError(f"Office reported success but {path.name} was not created correctly.")
    return {
        "result": f"Created and verified {path.name} in Microsoft {kind.title()}.",
        "path": str(path), "size": path.stat().st_size, "application": kind,
        "verified": True, "verification": "file_exists_and_nonempty", **detail,
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
    if not isinstance(rows, list) or any(not isinstance(row, list) for row in rows):
        raise ToolError("rows must be a two-dimensional array.")
    if len(rows) > 10_000 or sum(len(row) for row in rows) > 100_000:
        raise ToolError("Workbook data exceeds the 100,000 cell safety limit.")
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
                # Values only: formulas are always treated as plain text to
                # prevent CSV/formula injection and external-data functions.
                if isinstance(value, str) and value.startswith(("=", "+", "-", "@")):
                    value = "'" + value
                sheet.Cells(row_index, column_index).Value = value
        if args.get("header") and rows:
            sheet.Range(sheet.Cells(1, 1), sheet.Cells(1, len(rows[0]))).Font.Bold = True
        sheet.UsedRange.Columns.AutoFit()
        workbook.SaveAs(str(destination), FileFormat=51)  # xlOpenXMLWorkbook
        workbook.Saved = True
        return _verified(destination, "excel", {"rows": len(rows), "cells": sum(len(row) for row in rows), "sheet": name})
    except Exception as exc:
        try:
            if destination.exists(): destination.unlink()
        except OSError:
            pass
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
    app = _dispatch("powerpoint")
    presentation = None
    try:
        presentation = app.Presentations.Add()
        for index, item in enumerate(slides, 1):
            if not isinstance(item, dict):
                raise ToolError(f"Slide {index} must be an object with title and bullets.")
            title = str(item.get("title") or "")[:500]
            bullets: List[str] = [str(value)[:2_000] for value in (item.get("bullets") or [])][:50]
            slide = presentation.Slides.Add(index, 2)  # ppLayoutText
            slide.Shapes.Title.TextFrame.TextRange.Text = title
            slide.Shapes.Placeholders(2).TextFrame.TextRange.Text = "\r".join(bullets)
        presentation.SaveAs(str(destination), 24)  # ppSaveAsOpenXMLPresentation
        presentation.Saved = True
        return _verified(destination, "powerpoint", {"slides": len(slides)})
    except Exception as exc:
        try:
            if destination.exists(): destination.unlink()
        except OSError:
            pass
        raise ToolError(f"Microsoft PowerPoint could not create the presentation: {exc}") from exc
    finally:
        if not destination.exists():
            try:
                if presentation is not None: presentation.Close()
                app.Quit()
            except Exception:
                pass


@register("officeExportPdf")
def office_export_pdf(args: Dict[str, Any]) -> Dict[str, Any]:
    source = _resolve_file(args.get("path"), must_exist=True)
    _ensure_safe(source, False)
    destination = _destination(args.get("destination"), ".pdf")
    suffix = source.suffix.lower()
    app = None
    item = None
    try:
        if suffix == ".docx":
            app = _dispatch("word"); item = app.Documents.Open(str(source), ReadOnly=True); item.ExportAsFixedFormat(str(destination), 17)
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


__all__ = ["office_status", "office_create_word", "office_create_workbook", "office_create_presentation", "office_export_pdf"]
