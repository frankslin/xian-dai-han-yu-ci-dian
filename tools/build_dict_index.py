#!/usr/bin/env python3
"""
Build data/dict.json — a headword/pinyin -> approximate page index for the
scanned 《现代汉语词典》第7版 page images, from the community full-text
transcription at https://github.com/CNMan/XDHYCD7th (cached under
tools/.cache/, not the copyrighted scan images themselves).

The source text has NO per-entry page number. We approximate one using
data/toc.json's per-syllable page anchors (the same table the app already
uses for "jump to syllable"): every single-character headword resets the
current pinyin-syllable bucket; every multi-character (word) headword
inherits the bucket of the character entry above it, exactly mirroring how
the physical dictionary nests word entries under their lead character.
Within a bucket, entries are spread proportionally across its page range by
order of appearance. This is a best-effort estimate, not a ground truth
page number — the UI must present it as such.

Usage: python3 tools/build_dict_index.py
Reads:  tools/.cache/XDHYCD7th.txt, tools/.cache/西文字母开头的词语.txt, data/toc.json
Writes: data/dict.json
"""
import json
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache"
MAIN_TXT = CACHE / "XDHYCD7th.txt"
WESTERN_TXT = CACHE / "西文字母开头的词语.txt"
TOC_JSON = ROOT / "data" / "toc.json"
OUT_JSON = ROOT / "data" / "dict.json"

TONE_MARKS = {"̄", "́", "̌", "̀"}  # macron acute caron grave
GLYPH_MAP = {"ɑ": "a", "ɡ": "g", "ŋ": "ng", "ẑ": "zh", "ĉ": "ch", "ŝ": "sh"}

PINYIN_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
PINYIN_CHARS |= set("āáǎàōóǒòēéěèīíǐìūúǔùüǖǘǚǜêê̄ếê̌ềm̄ḿm̀ńňǹẑĉŝŋ")
PINYIN_CHARS |= set("ĀÁǍÀŌÓǑÒĒÉĚÈĪÍǏÌŪÚǓÙÜǕǗǙǛÊÊ̄ẾÊ̌ỀM̄ḾM̀ŃŇǸẐĈŜŊ")
PINYIN_CHARS |= set("ɑɡ'’·• ")

HEAD_LINE_RE = re.compile(r"^【(?P<head>[^】]+)】(?P<rest>.*)$")
LEAD_RE = re.compile(r"^(?P<sup>[¹²³⁴⁵⁶⁷⁸⁹]?)\s*(?P<variant>（[^）]*）)?\s*")
CJK_RE = re.compile(r"[㐀-鿿\U00020000-\U0002ebef]")


def strip_tone(s):
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if ch not in TONE_MARKS)
    return unicodedata.normalize("NFC", s)


def normalize_syllable(pinyin_raw):
    s = strip_tone(pinyin_raw)
    for a, b in GLYPH_MAP.items():
        s = s.replace(a, b)
    s = re.sub(r"[\s'’·•]", "", s)
    return s.lower()


def pretty_pinyin(pinyin_raw):
    s = pinyin_raw
    for a, b in GLYPH_MAP.items():
        s = s.replace(a, b)
    return s.strip()


def plain_pinyin(pinyin_raw):
    """Toneless, apostrophe/dot-free pinyin for client-side search matching."""
    return normalize_syllable(pinyin_raw)


def parse_entries(text, source):
    """Yield dicts: head, hanCount, pinyinRaw, text (rest after pinyin)."""
    for line in text.split("\n"):
        m = HEAD_LINE_RE.match(line)
        if not m:
            continue
        head = m.group("head")
        rest = m.group("rest")
        if not rest.strip():
            continue  # stub / not yet transcribed
        lead = LEAD_RE.match(rest)
        cursor = lead.end() if lead else 0
        i = cursor
        n = len(rest)
        while i < n and rest[i] in PINYIN_CHARS:
            i += 1
        pinyin_raw = rest[cursor:i].strip()
        remainder = rest[i:].strip()
        if not remainder:
            continue
        yield {
            "head": head,
            "hanCount": len(CJK_RE.findall(head)),
            "pinyinRaw": pinyin_raw,
            "text": remainder,
            "source": source,
        }


def build_syllable_table(toc):
    syllables = [s for s in toc["syllables"] if re.fullmatch(r"[a-züv]+", s["name"])]
    name_to_image = {}
    for s in syllables:
        name_to_image.setdefault(s["name"], s["image"])
    ordered = syllables
    n = len(ordered)
    end_image = [None] * n
    for i in range(n):
        start = ordered[i]["image"]
        end = None
        for j in range(i + 1, n):
            if ordered[j]["image"] >= start:
                end = ordered[j]["image"]
                break
        end_image[i] = end if end is not None else toc["totalImages"]
    range_by_name = {}
    for i, s in enumerate(ordered):
        # first occurrence wins if a name repeats (shouldn't, but be safe)
        range_by_name.setdefault(s["name"], (s["image"], end_image[i]))
    return range_by_name


def main():
    toc = json.loads(TOC_JSON.read_text(encoding="utf-8"))
    syllable_range = build_syllable_table(toc)
    section_image = {s["name"]: s["image"] for s in toc["sections"]}

    main_entries = list(parse_entries(MAIN_TXT.read_text(encoding="utf-8"), "main"))
    western_entries = list(
        parse_entries(WESTERN_TXT.read_text(encoding="utf-8"), "western")
    )

    # --- bucket assignment for the main corpus: single-char headwords reset
    # the current pinyin-syllable bucket; word entries inherit it.
    current_syllable = None
    misses = 0
    buckets = []  # list of (syllable_or_None, [entries])
    for e in main_entries:
        if e["hanCount"] == 1:
            syl = normalize_syllable(e["pinyinRaw"])
            if syl in syllable_range:
                current_syllable = syl
            else:
                misses += 1
        if not buckets or buckets[-1][0] != current_syllable:
            buckets.append((current_syllable, []))
        buckets[-1][1].append(e)

    out = []
    for syl, group in buckets:
        if syl is None or syl not in syllable_range:
            continue
        start, end = syllable_range[syl]
        n = len(group)
        span = max(end - start, 1)
        for k, e in enumerate(group):
            page = start + (k * span) // max(n, 1)
            page = min(page, end - 1) if end > start else start
            out.append(
                (
                    e["head"],
                    pretty_pinyin(e["pinyinRaw"]),
                    plain_pinyin(e["pinyinRaw"]),
                    page,
                    e["text"],
                )
            )

    # --- western-letter section: one flat bucket between its own TOC anchor
    # and the next section (附录).
    if western_entries:
        start = section_image.get("西文字母开头的词语")
        end = section_image.get("附录", toc["totalImages"])
        if start is not None:
            n = len(western_entries)
            span = max(end - start, 1)
            for k, e in enumerate(western_entries):
                page = start + (k * span) // max(n, 1)
                page = min(page, end - 1) if end > start else start
                out.append(
                (
                    e["head"],
                    pretty_pinyin(e["pinyinRaw"]),
                    plain_pinyin(e["pinyinRaw"]),
                    page,
                    e["text"],
                )
            )

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(
        json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"entries parsed: {len(main_entries)} main + {len(western_entries)} western")
    print(f"entries written: {len(out)}")
    print(f"single-char syllable lookup misses: {misses}")
    print(f"output size: {OUT_JSON.stat().st_size / 1e6:.2f} MB -> {OUT_JSON}")


if __name__ == "__main__":
    main()
