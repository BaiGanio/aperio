#!/usr/bin/env python3
import sys

from pypdf import PdfReader


EXPECTED_OUTLINE_TITLES = {
    "Recall should be part of the path",
    "Start a first recall",
    "Recover with evidence",
    "Recover when recall is empty",
}


def flatten_outline(items):
    titles = []
    for item in items:
        if isinstance(item, list):
            titles.extend(flatten_outline(item))
            continue
        title = getattr(item, "title", None)
        if title:
            titles.append(title)
    return titles


for filename in sys.argv[1:]:
    reader = PdfReader(filename)
    root = reader.trailer["/Root"]
    titles = set(flatten_outline(reader.outline))

    assert root.get("/Lang") == "en", f"{filename}: expected /Lang en"
    assert bool(root.get("/MarkInfo", {}).get("/Marked")), f"{filename}: expected marked PDF"
    assert root.get("/StructTreeRoot") is not None, f"{filename}: missing structure tree"
    assert EXPECTED_OUTLINE_TITLES <= titles, f"{filename}: incomplete outline: {sorted(titles)}"

    print(f"PASS: {filename} has /Lang en, /Marked true, a structure tree, and the expected outline")
