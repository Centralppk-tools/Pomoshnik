#!/usr/bin/env python3
"""Generate Rospatent identifying materials for Digital Assistant.

Run from the repository root:
    python app/generate_pdf.py

Dependency:
    python -m pip install reportlab
"""

from __future__ import annotations

import hashlib
import html
import os
import re
import sys
import textwrap
from io import BytesIO
from pathlib import Path
from typing import Iterable, Sequence

try:
    from PIL import Image as PILImage
    from PIL import ImageFilter
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import (
        Image,
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
        XPreformatted,
    )
except ImportError as exc:
    raise SystemExit(
        "Не найдена библиотека reportlab. Установите её командой:\n"
        "  python -m pip install reportlab"
    ) from exc


APP_DIR = Path(__file__).resolve().parent
OUTPUT_PATH = APP_DIR / "patent_doc.pdf"
VERSION = "2.4.6.2"
VERSION_DATE = "24.07.2026"
DOCUMENT_DATE = "28.07.2026"
PROGRAM_TITLE = "Цифровой помощник"

CURSOR_ASSETS_DIR = Path(
    r"C:\Users\Максим\.cursor\projects\g-rzd-Digital-Assistant\assets"
)
CURSOR_UPLOAD_PREFIX = (
    "c__Users________AppData_Roaming_Cursor_User_workspaceStorage_"
    "deff4e3e7cbb3aa81a6c5e6916b66a17_images_"
)


def uploaded_image(filename: str) -> Path:
    return CURSOR_ASSETS_DIR / f"{CURSOR_UPLOAD_PREFIX}{filename}"


CALENDAR_SCREENSHOTS = (
    (
        uploaded_image("IMG_0749-b310e1e2-8fe4-4f0d-8de3-1db7a826fa38.png"),
        "Рисунок 1 — Месячный календарь смен с цветовой маркировкой.",
    ),
    (
        uploaded_image("IMG_0750-addd81f2-61f8-4098-9b3b-41c3e00e8e5c.png"),
        "Рисунок 2 — Сводка выбранной смены и изменение маршрута.",
    ),
)
ROUTE_SCREENSHOTS = (
    (
        uploaded_image("IMG_0751-453befdf-3f65-41fc-9984-3a12ac0d3d66.png"),
        "Рисунок 3 — Формирование маршрута и карточки рейсов.",
    ),
    (
        uploaded_image("IMG_0752-fb114c7a-ec7c-4521-a5c5-635420246140.png"),
        "Рисунок 4 — Таймлайн расписания от начальной станции.",
    ),
    (
        uploaded_image("IMG_0756-0455f967-fba6-4e41-914f-92a16783be95.png"),
        "Рисунок 5 — Продолжение таймлайна до конечной станции.",
    ),
)
PROFILE_SCREENSHOTS = (
    (
        uploaded_image("IMG_0753-5524e166-c62a-4678-89cc-720c68919915.png"),
        "Рисунок 6 — Профиль, ближайшая смена и статистика месяца.",
    ),
    (
        uploaded_image("IMG_0755-6f488b2d-6a1d-4e14-b78f-db32d2fc557f.png"),
        "Рисунок 7 — Статистика, QR-блок АСПОЖ и управление профилем.",
    ),
)
SCREENSHOT_REDACTIONS = {
    str(PROFILE_SCREENSHOTS[0][0]): ((85, 310, 395, 420),),
    str(PROFILE_SCREENSHOTS[1][0]): ((125, 335, 345, 510),),
}

# The official abstract is intentionally kept below the 900-character limit.
ABSTRACT = (
    "Программа для ЭВМ «Цифровой помощник» представляет собой мобильное "
    "прогрессивное веб-приложение для планирования и сопровождения рабочих смен "
    "машинистов и помощников машиниста. Программа формирует календарь смен, "
    "подбирает нормативы маршрутов, строит последовательность рейсов по номерам "
    "поездов, отображает расписание и текущую станцию, рассчитывает рабочее время, "
    "пробег и ориентировочную оплату, ведет предупреждения и заметки, хранит QR-код "
    "АСПОЖ и экспортирует график в iCalendar. Предусмотрены автономная работа, "
    "локальное кеширование справочников и поездных данных, уведомления и обновление "
    "PWA. Область применения — информационная поддержка локомотивных бригад. "
    "Языки: JavaScript (ECMAScript), HTML5, CSS3. Среда выполнения: современный "
    "веб-браузер с поддержкой PWA на Android, iOS, Windows или macOS. "
    "Объем исходного текста: 609465 байт."
)


CODE_EXCERPTS = (
    (
        "1. Разметка входа и основной навигации",
        "index.html",
        77,
        180,
        "Точка входа пользовательского интерфейса: локальный вход, нижняя "
        "навигация и экран построения маршрута.",
    ),
    (
        "2. Конфигурация ядра и персональное локальное хранение",
        "index.html",
        483,
        624,
        "Инициализация предметных констант, offline-состояния и изоляция данных "
        "пользователей по табельному номеру.",
    ),
    (
        "3. Миграция кеша поездов и offline fallback справочников",
        "index.html",
        2027,
        2173,
        "Нормализация ключей «номер@дата», сериализация ниток и загрузка "
        "статических JSON с резервом из localStorage.",
    ),
    (
        "4. Формирование последовательности станций и расчет маршрута",
        "index.html",
        3520,
        3647,
        "Сопоставление фактических остановок с эталонным маршрутом, размещение "
        "предупреждений и расчет пробега.",
    ),
    (
        "5. Cache-first поиск поезда",
        "index.html",
        3700,
        3865,
        "Поиск нитки поезда с приоритетом локального кеша, статического UID, "
        "станционного табло и сетевого запроса.",
    ),
    (
        "6. Оркестрация построения маршрута",
        "index.html",
        4068,
        4205,
        "Параллельное получение поездов, защита от устаревших запросов и расчет "
        "времени, оборотов и суммарного пробега.",
    ),
    (
        "7. Нормализация и выбор шаблона смены",
        "index.html",
        6241,
        6425,
        "Обработка дат и маркеров дней недели, классификация дневных, ночных и "
        "утренних маршрутов, поиск точного и резервного норматива.",
    ),
    (
        "8. Рендер календаря и переход к маршруту",
        "index.html",
        9169,
        9295,
        "Построение месячной сетки смен и передача поездов выбранной смены в "
        "модуль маршрутов.",
    ),
    (
        "9. Service Worker: автономная оболочка и уведомления",
        "sw.js",
        1,
        232,
        "Версионированный precache, стратегии network-first/cache-first, очистка "
        "старых кешей и системные уведомления.",
    ),
)


def find_font(candidates: Sequence[Path], label: str) -> Path:
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    joined = "\n  ".join(str(path) for path in candidates)
    raise FileNotFoundError(
        f"Не найден шрифт {label} с поддержкой кириллицы. Проверены:\n  {joined}"
    )


def register_fonts() -> None:
    windows_fonts = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    common = (
        Path("/usr/share/fonts/truetype/dejavu"),
        Path("/usr/local/share/fonts"),
        Path.home() / ".fonts",
    )

    regular = find_font(
        (
            windows_fonts / "arial.ttf",
            common[0] / "DejaVuSans.ttf",
            common[1] / "DejaVuSans.ttf",
            common[2] / "DejaVuSans.ttf",
        ),
        "основного текста",
    )
    bold = find_font(
        (
            windows_fonts / "arialbd.ttf",
            common[0] / "DejaVuSans-Bold.ttf",
            common[1] / "DejaVuSans-Bold.ttf",
            common[2] / "DejaVuSans-Bold.ttf",
        ),
        "полужирного текста",
    )
    mono = find_font(
        (
            windows_fonts / "consola.ttf",
            common[0] / "DejaVuSansMono.ttf",
            common[1] / "DejaVuSansMono.ttf",
            common[2] / "DejaVuSansMono.ttf",
        ),
        "листинга",
    )

    pdfmetrics.registerFont(TTFont("PatentSans", str(regular)))
    pdfmetrics.registerFont(TTFont("PatentSansBold", str(bold)))
    pdfmetrics.registerFont(TTFont("PatentMono", str(mono)))
    pdfmetrics.registerFontFamily(
        "PatentSans",
        normal="PatentSans",
        bold="PatentSansBold",
    )


def source_metrics() -> dict[str, int]:
    files = [
        path
        for path in APP_DIR.rglob("*")
        if path.is_file() and path.suffix.lower() in {".html", ".js", ".css"}
    ]
    return {
        "files": len(files),
        "bytes": sum(path.stat().st_size for path in files),
        "lines": sum(
            len(path.read_text(encoding="utf-8", errors="replace").splitlines())
            for path in files
        ),
    }


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def escaped(value: object) -> str:
    return html.escape(str(value), quote=False)


def numbered_source(path: Path, start: int, end: int) -> list[str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    if start < 1 or end > len(lines) or start > end:
        raise ValueError(
            f"Некорректный диапазон {path.name}:{start}-{end}; "
            f"в файле {len(lines)} строк"
        )
    width = len(str(end))
    result: list[str] = []
    for line_number in range(start, end + 1):
        raw = lines[line_number - 1].replace("\t", "    ").rstrip()
        raw = re.sub(
            r"https?://[^'\"\s`]+",
            "[ВНЕШНИЙ_URL_ИСКЛЮЧЕН]",
            raw,
        )
        prefix = f"{line_number:>{width}} | "
        wrapped = textwrap.wrap(
            raw,
            width=105,
            replace_whitespace=False,
            drop_whitespace=False,
            break_long_words=True,
            break_on_hyphens=False,
        ) or [""]
        result.append(prefix + wrapped[0])
        result.extend(" " * len(prefix) + continuation for continuation in wrapped[1:])
    return result


def chunks(values: Sequence[str], size: int) -> Iterable[Sequence[str]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


def make_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "PatentTitle",
            parent=base["Title"],
            fontName="PatentSansBold",
            fontSize=19,
            leading=23,
            alignment=TA_CENTER,
            textColor=colors.HexColor("#111827"),
            spaceAfter=10 * mm,
        ),
        "subtitle": ParagraphStyle(
            "PatentSubtitle",
            parent=base["Normal"],
            fontName="PatentSans",
            fontSize=11,
            leading=15,
            alignment=TA_CENTER,
            textColor=colors.HexColor("#374151"),
        ),
        "h1": ParagraphStyle(
            "PatentH1",
            parent=base["Heading1"],
            fontName="PatentSansBold",
            fontSize=15,
            leading=19,
            textColor=colors.HexColor("#111827"),
            spaceBefore=5 * mm,
            spaceAfter=3 * mm,
            keepWithNext=True,
        ),
        "h2": ParagraphStyle(
            "PatentH2",
            parent=base["Heading2"],
            fontName="PatentSansBold",
            fontSize=11,
            leading=14,
            textColor=colors.HexColor("#1F2937"),
            spaceBefore=4 * mm,
            spaceAfter=2 * mm,
            keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "PatentBody",
            parent=base["BodyText"],
            fontName="PatentSans",
            fontSize=9.5,
            leading=13.5,
            alignment=TA_JUSTIFY,
            textColor=colors.HexColor("#111827"),
            spaceAfter=2.4 * mm,
        ),
        "small": ParagraphStyle(
            "PatentSmall",
            parent=base["BodyText"],
            fontName="PatentSans",
            fontSize=8,
            leading=11,
            alignment=TA_LEFT,
            textColor=colors.HexColor("#4B5563"),
            spaceAfter=1.5 * mm,
        ),
        "caption": ParagraphStyle(
            "PatentCaption",
            parent=base["BodyText"],
            fontName="PatentSans",
            fontSize=7.5,
            leading=9.5,
            alignment=TA_CENTER,
            textColor=colors.HexColor("#374151"),
            spaceBefore=1.5 * mm,
        ),
        "code": ParagraphStyle(
            "PatentCode",
            parent=base["Code"],
            fontName="PatentMono",
            fontSize=5.8,
            leading=7.1,
            leftIndent=3 * mm,
            rightIndent=3 * mm,
            borderColor=colors.HexColor("#D1D5DB"),
            borderWidth=0.4,
            borderPadding=2.5 * mm,
            backColor=colors.HexColor("#F9FAFB"),
            textColor=colors.HexColor("#111827"),
            spaceAfter=2 * mm,
            splitLongWords=True,
        ),
    }


def paragraph(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(escaped(text), style)


def bullet(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(f"• {escaped(text)}", style)


def add_table(
    story: list,
    rows: Sequence[Sequence[str]],
    widths: Sequence[float],
    styles: dict[str, ParagraphStyle],
) -> None:
    data = [
        [Paragraph(escaped(cell), styles["small"]) for cell in row]
        for row in rows
    ]
    table = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, 0), "PatentSansBold"),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E5E7EB")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#111827")),
                ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#9CA3AF")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(table)
    story.append(Spacer(1, 3 * mm))


def make_screenshot_flowable(path: Path) -> Image:
    redactions = SCREENSHOT_REDACTIONS.get(str(path), ())
    if not redactions:
        image = Image(str(path))
    else:
        with PILImage.open(path) as source:
            prepared = source.convert("RGB")
        for box in redactions:
            blurred = prepared.crop(box).filter(ImageFilter.GaussianBlur(radius=18))
            prepared.paste(blurred, box)
        buffer = BytesIO()
        prepared.save(buffer, format="JPEG", quality=92, optimize=True)
        buffer.seek(0)
        image = Image(buffer)
        image._patent_source_buffer = buffer

    intrinsic_width = image.imageWidth
    intrinsic_height = image.imageHeight
    image.drawWidth = 73 * mm
    image.drawHeight = intrinsic_height * image.drawWidth / intrinsic_width
    return image


def add_screenshot_gallery(
    story: list,
    screenshots: Sequence[tuple[Path, str]],
    styles: dict[str, ParagraphStyle],
) -> None:
    for path, caption in screenshots:
        if not path.is_file():
            raise FileNotFoundError(f"Не найден скриншот интерфейса: {path}")

    for group_index, group in enumerate(chunks(list(screenshots), 2)):
        if group_index:
            story.append(PageBreak())
        cells = [make_screenshot_flowable(path) for path, _ in group]
        captions = [
            Paragraph(escaped(caption), styles["caption"])
            for _, caption in group
        ]
        table = Table(
            (cells, captions),
            colWidths=tuple(78 * mm for _ in group),
            hAlign="CENTER",
        )
        table.setStyle(
            TableStyle(
                [
                    ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 2 * mm),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 2 * mm),
                    ("TOPPADDING", (0, 0), (-1, -1), 0),
                    ("BOTTOMPADDING", (0, 0), (-1, 0), 1.5 * mm),
                ]
            )
        )
        story.append(table)
        story.append(Spacer(1, 3 * mm))


def draw_page(canvas, doc) -> None:
    canvas.saveState()
    canvas.setFont("PatentSans", 7.5)
    canvas.setFillColor(colors.HexColor("#6B7280"))
    canvas.drawString(
        doc.leftMargin,
        11 * mm,
        f"{PROGRAM_TITLE} · идентифицирующие материалы · версия {VERSION}",
    )
    canvas.drawRightString(A4[0] - doc.rightMargin, 11 * mm, f"Страница {doc.page}")
    canvas.setStrokeColor(colors.HexColor("#D1D5DB"))
    canvas.setLineWidth(0.35)
    canvas.line(doc.leftMargin, 14 * mm, A4[0] - doc.rightMargin, 14 * mm)
    canvas.restoreState()


def build_story(styles: dict[str, ParagraphStyle]) -> list:
    metrics = source_metrics()
    if len(ABSTRACT) > 900:
        raise ValueError(f"Реферат превышает 900 знаков: {len(ABSTRACT)}")

    story: list = [
        Spacer(1, 34 * mm),
        paragraph("ДЕПОНИРУЕМЫЕ МАТЕРИАЛЫ", styles["subtitle"]),
        Spacer(1, 5 * mm),
        paragraph("Программа для ЭВМ", styles["subtitle"]),
        Spacer(1, 9 * mm),
        paragraph(f"«{PROGRAM_TITLE}»", styles["title"]),
        paragraph(
            "Реферат, описание пользовательского интерфейса и фрагменты "
            "исходного текста, идентифицирующие программу",
            styles["subtitle"],
        ),
        Spacer(1, 18 * mm),
    ]

    add_table(
        story,
        (
            ("Параметр", "Значение"),
            ("Версия программы", f"{VERSION} STABLE"),
            ("Дата версии", VERSION_DATE),
            ("Дата формирования материалов", DOCUMENT_DATE),
            ("Тип программы", "Прогрессивное веб-приложение (PWA)"),
            (
                "Исходный текст",
                f"{metrics['bytes']} байт, {metrics['lines']} строк, "
                f"{metrics['files']} файлов HTML/JavaScript/CSS",
            ),
        ),
        (55 * mm, 105 * mm),
        styles,
    )
    story.extend(
        [
            Spacer(1, 15 * mm),
            paragraph(
                "Сведения об авторе и правообладателе указываются заявителем "
                "в заявлении на государственную регистрацию.",
                styles["small"],
            ),
            PageBreak(),
            paragraph("1. Реферат", styles["h1"]),
            paragraph(ABSTRACT, styles["body"]),
            paragraph(
                f"Объем реферата: {len(ABSTRACT)} знаков с пробелами.",
                styles["small"],
            ),
            paragraph("2. Назначение и область применения", styles["h1"]),
            paragraph(
                "«Цифровой помощник» предназначен для персональной информационной "
                "поддержки локомотивной бригады при подготовке к рабочей смене и "
                "во время ее выполнения. Программа объединяет график смен, "
                "нормативные данные маршрута, сведения о поездах, расписание "
                "остановок, предупреждения, заметки и месячную статистику.",
                styles["body"],
            ),
            paragraph(
                "Основная область применения — оперативная деятельность машинистов "
                "и помощников машиниста на железнодорожных направлениях. "
                "Предметные справочники текущей версии ориентированы прежде всего "
                "на Ярославское направление. Программа является вспомогательным "
                "информационным средством и не заменяет обязательные нормативные "
                "документы и распоряжения перевозчика.",
                styles["body"],
            ),
            paragraph("3. Решаемые задачи", styles["h1"]),
        ]
    )
    for item in (
        "ведение персонального календаря дневных, ночных и утренних смен;",
        "поиск норматива смены по маршруту, календарной дате и дню недели;",
        "построение последовательности рейсов по номерам поездов;",
        "отображение маршрута, остановок, времени хода, оборотов и пробега;",
        "сопоставление станций со справочником и отображение предупреждений;",
        "учет рабочих и ночных часов, расчет месячной статистики и ориентировочной оплаты;",
        "хранение заметок к сменам и станциям, а также QR-кода АСПОЖ;",
        "экспорт графика смен в файл iCalendar (.ics);",
        "автономная работа с локальными справочниками и кешированными данными;",
        "уведомления по событиям смены и доставка обновлений PWA.",
    ):
        story.append(bullet(item, styles["body"]))

    story.extend(
        [
            paragraph("4. Функциональные возможности", styles["h1"]),
        ]
    )
    add_table(
        story,
        (
            ("Подсистема", "Основные функции"),
            (
                "Календарь смен",
                "Месячная сетка, конструктор смены, связанные ночь/утро, "
                "заметки, экспорт .ics.",
            ),
            (
                "Маршрут",
                "До 10 поездов, cache-first поиск ниток, карточки рейсов, "
                "пробег, обороты, тормозные точки и предупреждения.",
            ),
            (
                "Расписание",
                "Таймлайн остановок, текущая и следующая станция, live-часы, "
                "заметки и уведомления.",
            ),
            (
                "Личный кабинет",
                "Табельный номер, должность, ближайшая смена, часы, норма, "
                "ориентировочная оплата и QR АСПОЖ.",
            ),
            (
                "Автономная работа",
                "Service Worker, Cache API, localStorage, локальные JSON-справочники "
                "и резерв поездных данных.",
            ),
        ),
        (43 * mm, 117 * mm),
        styles,
    )

    story.extend(
        [
            paragraph("5. Архитектура, языки и среда выполнения", styles["h1"]),
            paragraph(
                "Программа реализована как статическое одностраничное приложение. "
                "Файл index.html содержит разметку экранов и основную бизнес-логику "
                "на JavaScript; девять CSS-файлов разделяют оформление по "
                "функциональным областям; sw.js реализует автономную оболочку и "
                "уведомления. Сборщик и JavaScript-фреймворк в runtime не используются.",
                styles["body"],
            ),
        ]
    )
    add_table(
        story,
        (
            ("Характеристика", "Значение"),
            ("Языки", "JavaScript (ECMAScript), HTML5, CSS3"),
            (
                "Web API",
                "Fetch, Service Worker, Cache API, localStorage, Notifications, "
                "Web Share, Canvas, FileReader",
            ),
            (
                "Среда выполнения",
                "Современный веб-браузер с поддержкой PWA; статический HTTPS-хостинг",
            ),
            (
                "Операционные системы",
                "Android, iOS, Windows, macOS и иные ОС с совместимым браузером",
            ),
            (
                "Внешние источники",
                "API расписаний через прокси; Google Apps Script для обратной связи; "
                "CloudTips и Telegram как внешние переходы",
            ),
            ("Runtime-зависимости", "Отсутствуют; клиент написан на Vanilla JavaScript"),
        ),
        (45 * mm, 115 * mm),
        styles,
    )

    story.extend(
        [
            paragraph("6. Краткая история разработки", styles["h1"]),
            paragraph(
                "Git-история содержит 53 коммита одного автора за период "
                "24.06.2026–24.07.2026. Первый доступный коммит a205197 фиксирует "
                "версию 2.3.4; более ранние версии 2.1.0–2.3.3 описаны в журнале "
                "Version/Commit.txt, но отсутствуют как самостоятельные коммиты.",
                styles["body"],
            ),
        ]
    )
    add_table(
        story,
        (
            ("Дата / коммит", "Этап"),
            ("24.06.2026 · a205197", "Стабилизация навигации версии 2.3.4."),
            ("27.06.2026 · 6611093", "Кеш поездов и локальная резервная база."),
            ("07.07.2026 · 240e8cf", "Переход к offline-first PWA."),
            ("11.07.2026 · aa7a600", "Ребрендинг в «Цифровой помощник»."),
            ("14.07.2026 · 3e45746", "Уведомления и локальная база смен."),
            ("24.07.2026 · 83b9a82", "Экспорт смен в универсальный формат .ics."),
            ("24.07.2026 · 1216024", "Стабильный релиз 2.4.6.2."),
        ),
        (47 * mm, 113 * mm),
        styles,
    )

    story.extend(
        [
            PageBreak(),
            paragraph("7. Описание пользовательского интерфейса", styles["h1"]),
            paragraph("7.1. Экран входа", styles["h2"]),
            paragraph(
                "Стартовый экран содержит логотип, название программы, поле "
                "табельного номера и кнопку входа. До создания локальной сессии "
                "остальные экраны заблокированы. Введенный номер используется для "
                "разделения персональных данных на устройстве.",
                styles["body"],
            ),
            paragraph("7.2. График смен", styles["h2"]),
            paragraph(
                "Главный экран представляет календарь месяца с цветовой "
                "маркировкой смен. Пользователь выбирает день и маршрут, просматривает "
                "явку, рабочее время и поезда, добавляет заметку или переходит к "
                "построению маршрута. График месяца можно экспортировать в .ics.",
                styles["body"],
            ),
            PageBreak(),
            paragraph(
                "7.2.1. Визуальное представление экрана графика смен",
                styles["h2"],
            ),
            paragraph(
                "Месячный обзор показывает распределение дневных, ночных и "
                "технических смен. После выбора даты открывается сводка с маршрутом, "
                "временем работы, поездами, расчетными показателями и средствами "
                "изменения маршрута.",
                styles["body"],
            ),
        ]
    )
    add_screenshot_gallery(story, CALENDAR_SCREENSHOTS, styles)
    story.extend(
        [
            paragraph("7.3. Маршрут и расписание", styles["h2"]),
            paragraph(
                "Экран разделен на вкладки «Маршрут» и «Расписание». На первой "
                "задаются дата, ночной режим и до десяти поездов; результат "
                "представляется карточками со временем, остановками, пробегом, "
                "оборотами и предупреждениями. Вторая вкладка показывает таймлайн "
                "станций, live-часы, активный участок и заметки.",
                styles["body"],
            ),
            PageBreak(),
            paragraph(
                "7.3.1. Визуальное представление маршрута и расписания",
                styles["h2"],
            ),
            paragraph(
                "Первый экран показывает параметры смены и карточки найденных "
                "рейсов. После выбора рейса программа строит последовательный "
                "таймлайн станций с временем прибытия, отправления, километражем "
                "и предметными отметками.",
                styles["body"],
            ),
        ]
    )
    add_screenshot_gallery(story, ROUTE_SCREENSHOTS, styles)
    story.extend(
        [
            paragraph("7.4. Личный кабинет", styles["h2"]),
            paragraph(
                "Профиль содержит имя, должность и табельный номер, ближайшую смену, "
                "статистику рабочих часов и ориентировочной оплаты за выбранный "
                "месяц. Дополнительно пользователь может сохранить и открыть "
                "QR-код АСПОЖ.",
                styles["body"],
            ),
            PageBreak(),
            paragraph(
                "7.4.1. Визуальное представление личного кабинета",
                styles["h2"],
            ),
            paragraph(
                "Личный кабинет объединяет сведения о сотруднике, карточку "
                "ближайшей смены, финансовую и часовую статистику месяца, а также "
                "блок хранения QR-кода АСПОЖ. Персональные значения и содержимое "
                "QR-кода на иллюстрациях скрыты.",
                styles["body"],
            ),
        ]
    )
    add_screenshot_gallery(story, PROFILE_SCREENSHOTS, styles)
    story.extend(
        [
            paragraph("7.5. Общие элементы", styles["h2"]),
            paragraph(
                "Нижняя панель обеспечивает переходы между календарем, маршрутом "
                "и профилем. Интерфейс адаптирован для смартфонов и поддерживает "
                "свайпы. Отдельные overlay-окна используются для обновлений, "
                "заметок, предупреждений, обратной связи и подтверждения действий.",
                styles["body"],
            ),
            paragraph("8. Состав программы и объем", styles["h1"]),
            paragraph(
                f"Измеренный объем файлов исходного текста текущей версии: "
                f"{metrics['bytes']} байт, {metrics['lines']} строк в "
                f"{metrics['files']} файлах HTML, JavaScript и CSS. JSON-справочники "
                "составляют отдельный набор runtime-данных и в этот показатель не входят.",
                styles["body"],
            ),
        ]
    )
    add_table(
        story,
        (
            ("Компонент", "Назначение"),
            ("app/index.html", "Точка входа, все экраны и основная бизнес-логика."),
            ("app/sw.js", "Автономный кеш, lifecycle PWA и уведомления."),
            ("app/styles/*.css", "Девять модулей оформления и адаптивности."),
            (
                "app/spr.json, app/trains-local.json",
                "Предметные справочники и offline-резерв поездов.",
            ),
            (
                "app/data/*.json",
                "Шаблоны смен, локальные маршруты, UID и сведения о релизах.",
            ),
            ("app/manifest.json", "Метаданные устанавливаемого PWA."),
        ),
        (55 * mm, 105 * mm),
        styles,
    )

    story.extend(
        [
            paragraph("9. Отбор идентифицирующих материалов", styles["h1"]),
            paragraph(
                "В листинг включены фрагменты, раскрывающие точку входа, "
                "персональное хранение, алгоритмы кеширования, построение маршрутов, "
                "обработку смен и Service Worker. Исключены реальные настройки "
                "внешних сервисов, бинарные изображения, исторические снимки, "
                "сторонние библиотеки, инструменты разработки и сгенерированные "
                "массивы данных.",
                styles["body"],
            ),
            paragraph(
                "Диапазоны строк относятся к исходникам версии 2.4.6.2 на дату "
                "формирования настоящего документа.",
                styles["small"],
            ),
            PageBreak(),
            paragraph("10. Фрагменты исходного текста", styles["h1"]),
        ]
    )

    for title, relative_path, start, end, description in CODE_EXCERPTS:
        source_path = APP_DIR / relative_path
        story.append(paragraph(title, styles["h2"]))
        story.append(
            paragraph(
                f"Файл: app/{relative_path}; строки {start}–{end}. {description}",
                styles["small"],
            )
        )
        lines = numbered_source(source_path, start, end)
        for block in chunks(lines, 42):
            story.append(
                XPreformatted(
                    escaped("\n".join(block)),
                    styles["code"],
                )
            )

    story.extend(
        [
            PageBreak(),
            paragraph("11. Контрольная ведомость", styles["h1"]),
            paragraph(
                "Хеши позволяют сопоставить листинг с файлами, использованными "
                "при формировании настоящего документа.",
                styles["body"],
            ),
        ]
    )
    add_table(
        story,
        (
            ("Файл", "SHA-256"),
            ("app/index.html", sha256(APP_DIR / "index.html")),
            ("app/sw.js", sha256(APP_DIR / "sw.js")),
        ),
        (45 * mm, 115 * mm),
        styles,
    )
    story.extend(
        [
            paragraph("12. Примечание о подаче", styles["h1"]),
            paragraph(
                "Настоящий файл представляет комплект идентифицирующих материалов "
                "и не заменяет заявление на государственную регистрацию. Текст "
                "реферата может дополнительно переноситься в соответствующее поле "
                "заявления. Требование к PDF/A и разделение реферата и листинга "
                "следует проверить для выбранного способа подачи в ФИПС.",
                styles["body"],
            ),
        ]
    )
    return story


def generate_pdf() -> Path:
    register_fonts()
    styles = make_styles()
    document = SimpleDocTemplate(
        str(OUTPUT_PATH),
        pagesize=A4,
        rightMargin=18 * mm,
        leftMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=20 * mm,
        title=f"{PROGRAM_TITLE}: материалы для регистрации программы для ЭВМ",
        author="Заявитель программы «Цифровой помощник»",
        subject="Реферат и идентифицирующие фрагменты исходного текста",
        creator="app/generate_pdf.py (ReportLab)",
    )
    document.build(
        build_story(styles),
        onFirstPage=draw_page,
        onLaterPages=draw_page,
    )
    return OUTPUT_PATH


def main() -> int:
    try:
        output = generate_pdf()
    except (FileNotFoundError, OSError, ValueError) as exc:
        print(f"Ошибка генерации PDF: {exc}", file=sys.stderr)
        return 1

    print(f"Создан документ: {output}")
    print(f"Размер: {output.stat().st_size} байт")
    print(f"Реферат: {len(ABSTRACT)} знаков")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
