#!/usr/bin/env python3
"""
Build data/dict/*.json — a headword/pinyin -> approximate page index for the
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

Output is sharded by pinyin-initial-letter ranges (data/dict/<range>.json,
e.g. "a-e.json"), sized to be roughly even rather than one per letter (some
letters — s/y/z — have 10x the entries of others — o/e), plus a standalone
"west" shard for the Western-letter-headword section. data/dict/manifest.json
maps each letter to its shard file so the client only ever fetches the
shard(s) a given query actually needs, not the whole corpus. A row's id for
linking (?w=) is "<shardKey>:<indexWithinShard>".

Usage: python3 tools/build_dict_index.py [--shards N]
Reads:  tools/.cache/XDHYCD7th.txt, tools/.cache/西文字母开头的词语.txt, data/toc.json
Writes: data/dict/manifest.json, data/dict/<range>.json
"""
import argparse
import json
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache"
MAIN_TXT = CACHE / "XDHYCD7th.txt"
WESTERN_TXT = CACHE / "西文字母开头的词语.txt"
TOC_JSON = ROOT / "data" / "toc.json"
OUT_DIR = ROOT / "data" / "dict"
MANIFEST_JSON = OUT_DIR / "manifest.json"

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


def row_json_size(row):
    # byte length, not char length — ensure_ascii=False means CJK text is
    # stored as literal UTF-8 (3 bytes/char), so len(str) badly undercounts.
    return len(json.dumps(row, ensure_ascii=False).encode("utf-8"))


def partition_letters(letter_sizes, target_shards):
    """Split letters, in their given (pinyin-alphabetical) order, into at most
    `target_shards` contiguous ranges, minimizing the largest range's total
    byte size (the classic "allocate books to minimize the max" problem,
    solved by binary search on the answer + a greedy feasibility check)."""
    letters = list(letter_sizes.keys())
    sizes = [letter_sizes[l] for l in letters]
    if len(letters) <= target_shards:
        return [[l] for l in letters]

    def shards_needed(cap):
        count, cur = 1, 0
        for sz in sizes:
            if cur + sz > cap:
                count += 1
                cur = sz
            else:
                cur += sz
        return count

    lo, hi = max(sizes), sum(sizes)
    while lo < hi:
        mid = (lo + hi) // 2
        if shards_needed(mid) <= target_shards:
            hi = mid
        else:
            lo = mid + 1

    cap = lo
    shards, current, current_size = [], [], 0
    for letter, sz in zip(letters, sizes):
        if current and current_size + sz > cap:
            shards.append(current)
            current, current_size = [], 0
        current.append(letter)
        current_size += sz
    if current:
        shards.append(current)
    return shards


def shard_key(letters):
    return letters[0] if len(letters) == 1 else f"{letters[0]}-{letters[-1]}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards", type=int, default=10, help="target number of main-corpus shards (letters are merged to balance size)")
    args = ap.parse_args()

    toc = json.loads(TOC_JSON.read_text(encoding="utf-8"))
    syllable_range = build_syllable_table(toc)
    section_image = {s["name"]: s["image"] for s in toc["sections"]}

    main_entries = list(parse_entries(MAIN_TXT.read_text(encoding="utf-8"), "main"))
    western_entries = list(
        parse_entries(WESTERN_TXT.read_text(encoding="utf-8"), "western")
    )

    # --- bucket assignment for the main corpus: single-char headwords reset
    # the current pinyin-syllable bucket; word entries inherit it. The
    # syllable's own first letter (not any individual entry's, which can be
    # noisy/empty on edge cases — see README misses) decides the shard.
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

    rows_by_letter = {}  # letter -> [row, ...]
    for syl, group in buckets:
        if syl is None or syl not in syllable_range:
            continue
        start, end = syllable_range[syl]
        n = len(group)
        span = max(end - start, 1)
        letter = syl[0]
        for k, e in enumerate(group):
            page = start + (k * span) // max(n, 1)
            page = min(page, end - 1) if end > start else start
            row = (
                e["head"],
                pretty_pinyin(e["pinyinRaw"]),
                plain_pinyin(e["pinyinRaw"]),
                page,
                e["text"],
            )
            rows_by_letter.setdefault(letter, []).append(row)

    # --- western-letter section: one flat bucket between its own TOC anchor
    # and the next section (附录), shipped as its own "west" shard.
    west_rows = []
    if western_entries:
        start = section_image.get("西文字母开头的词语")
        end = section_image.get("附录", toc["totalImages"])
        if start is not None:
            n = len(western_entries)
            span = max(end - start, 1)
            for k, e in enumerate(western_entries):
                page = start + (k * span) // max(n, 1)
                page = min(page, end - 1) if end > start else start
                west_rows.append(
                    (
                        e["head"],
                        pretty_pinyin(e["pinyinRaw"]),
                        plain_pinyin(e["pinyinRaw"]),
                        page,
                        e["text"],
                    )
                )

    # --- partition the (pinyin-ordered) letters into evenly-sized shards ---
    letter_order = [l for l in "abcdefghjklmnopqrstwxyz" if l in rows_by_letter]
    letter_sizes = {
        l: sum(row_json_size(r) for r in rows_by_letter[l]) for l in letter_order
    }
    partitions = partition_letters(letter_sizes, args.shards)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob("*.json"):
        old.unlink()

    manifest_shards = []
    letters_map = {}

    def write_shard(key, rows):
        path = OUT_DIR / f"{key}.json"
        path.write_text(
            json.dumps(rows, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        manifest_shards.append(
            {"key": key, "file": f"data/dict/{key}.json", "count": len(rows), "bytes": path.stat().st_size}
        )

    for letters in partitions:
        key = shard_key(letters)
        rows = [r for l in letters for r in rows_by_letter[l]]
        write_shard(key, rows)
        for l in letters:
            letters_map[l] = key

    if west_rows:
        write_shard("west", west_rows)

    manifest = {"letters": letters_map, "west": "west" if west_rows else None, "shards": manifest_shards}
    MANIFEST_JSON.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")

    total_rows = sum(s["count"] for s in manifest_shards)
    total_bytes = sum(s["bytes"] for s in manifest_shards)
    print(f"entries parsed: {len(main_entries)} main + {len(western_entries)} western")
    print(f"entries written: {total_rows} across {len(manifest_shards)} shards")
    print(f"single-char syllable lookup misses: {misses}")
    for s in manifest_shards:
        print(f"  {s['key']:>8s}  {s['count']:6d} rows  {s['bytes']/1024:8.1f} KB")
    print(f"total: {total_bytes / 1e6:.2f} MB -> {OUT_DIR}")


if __name__ == "__main__":
    main()
