"""Разбор multipart/form-data без модуля cgi (deprecated в Python 3.13)."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass


@dataclass
class Part:
    name: str
    filename: str | None
    data: bytes


def _parse_content_disposition(header: str) -> tuple[str | None, str | None]:
    name = None
    filename = None
    for piece in header.split(";"):
        piece = piece.strip()
        if piece.lower().startswith("name="):
            name = piece.split("=", 1)[1].strip().strip('"')
        elif piece.lower().startswith("filename="):
            filename = piece.split("=", 1)[1].strip().strip('"')
            if filename.lower() in ("", '""'):
                filename = None
    return name, filename


def parse_multipart(body: bytes, content_type: str) -> list[Part]:
    if "multipart/form-data" not in (content_type or ""):
        raise ValueError("ожидается multipart/form-data")

    match = re.search(r"boundary=([^;\s]+)", content_type, re.I)
    if not match:
        raise ValueError("нет boundary в Content-Type")
    boundary = match.group(1).strip().strip('"').encode("ascii", "ignore")
    if not boundary:
        raise ValueError("пустой boundary")

    delimiter = b"--" + boundary
    closing = delimiter + b"--"
    parts: list[Part] = []

    pos = body.find(delimiter)
    if pos < 0:
        raise ValueError("некорректное тело multipart")

    while pos >= 0:
        pos += len(delimiter)
        if body.startswith(b"--", pos):
            break
        if body.startswith(b"\r\n", pos):
            pos += 2

        next_pos = body.find(delimiter, pos)
        chunk = body[pos:next_pos] if next_pos >= 0 else body[pos:]
        if chunk.endswith(b"\r\n"):
            chunk = chunk[:-2]

        header_end = chunk.find(b"\r\n\r\n")
        if header_end < 0:
            pos = next_pos
            continue

        headers = chunk[:header_end].decode("utf-8", errors="replace")
        data = chunk[header_end + 4:]
        name = None
        filename = None
        for line in headers.split("\r\n"):
            if line.lower().startswith("content-disposition:"):
                name, filename = _parse_content_disposition(line.split(":", 1)[1])
                break

        if name:
            parts.append(Part(name=name, filename=filename, data=data))
        pos = next_pos

    if not parts:
        raise ValueError("multipart без полей")
    return parts


def parse_preview_form(body: bytes, content_type: str) -> tuple[dict, list[tuple[str, bytes]]]:
    """meta JSON + список (имя_файла, bytes) в порядке file_0, file_1, …"""
    parts = parse_multipart(body, content_type)
    meta_raw = None
    files: dict[int, tuple[str | None, bytes]] = {}

    for part in parts:
        if part.name == "meta":
            meta_raw = part.data.decode("utf-8")
            continue
        file_match = re.fullmatch(r"file_(\d+)", part.name or "")
        if file_match:
            idx = int(file_match.group(1))
            files[idx] = (part.filename, part.data)

    if not meta_raw:
        raise ValueError("нет поля meta")

    meta = json.loads(meta_raw)
    if not isinstance(meta, dict):
        raise ValueError("meta должен быть JSON-объектом")

    ordered: list[tuple[str, bytes]] = []
    for idx in sorted(files):
        filename, data = files[idx]
        ordered.append((filename or f"upload_{idx}.pdf", data))

    if not ordered:
        raise ValueError("нет файлов")

    return meta, ordered
