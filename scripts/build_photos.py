#!/usr/bin/env python3
"""
扫描 photos/ 下的照片，自动生成 photos.json 和缩略图。

文件名约定（用下划线分隔）：
    地点_日期_说明.jpg      例如: 东京涩谷_2025-03-12_樱花季.jpg
    地点_日期.jpg           例如: 仙台_2025-06-01.jpg
    地点.jpg               （日期尝试从 EXIF 读取）

坐标来源优先级：
    1. overrides.json 中手动指定的坐标（键为文件名）
    2. 照片 EXIF 中的 GPS 信息
    3. 用文件名中的地点名称调用 Nominatim (OpenStreetMap) 地理编码

用法:  python3 scripts/build_photos.py
依赖:  pip install Pillow
"""

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ExifTags

ROOT = Path(__file__).resolve().parent.parent
PHOTOS_DIR = ROOT / "photos"
THUMBS_DIR = PHOTOS_DIR / "thumbs"
OUTPUT_JSON = ROOT / "photos.json"
OVERRIDES_FILE = ROOT / "overrides.json"
GEOCACHE_FILE = ROOT / "scripts" / "geocache.json"

THUMB_SIZE = 128          # 缩略图最长边像素
EXTS = {".jpg", ".jpeg", ".png", ".webp"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def load_json(path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"警告: {path.name} 不是合法 JSON，已忽略", file=sys.stderr)
    return default


def parse_filename(stem):
    """从文件名解析 (地点, 日期, 说明)。"""
    parts = stem.split("_")
    location = parts[0].strip()
    date = None
    caption = ""
    rest = parts[1:]
    if rest and DATE_RE.match(rest[0]):
        date = rest[0]
        rest = rest[1:]
    caption = " ".join(rest).strip()
    return location, date, caption


def exif_data(img):
    try:
        raw = img._getexif()
    except Exception:
        raw = None
    if not raw:
        return {}
    return {ExifTags.TAGS.get(k, k): v for k, v in raw.items()}


def dms_to_deg(dms, ref):
    try:
        deg = float(dms[0]) + float(dms[1]) / 60 + float(dms[2]) / 3600
    except (TypeError, ZeroDivisionError, IndexError):
        return None
    if ref in ("S", "W"):
        deg = -deg
    return round(deg, 6)


def exif_gps(exif):
    gps_raw = exif.get("GPSInfo")
    if not gps_raw:
        return None
    gps = {ExifTags.GPSTAGS.get(k, k): v for k, v in gps_raw.items()}
    lat = dms_to_deg(gps.get("GPSLatitude"), gps.get("GPSLatitudeRef"))
    lng = dms_to_deg(gps.get("GPSLongitude"), gps.get("GPSLongitudeRef"))
    if lat is None or lng is None:
        return None
    return lat, lng


def exif_date(exif):
    for key in ("DateTimeOriginal", "DateTime"):
        val = exif.get(key)
        if val:
            m = re.match(r"(\d{4}):(\d{2}):(\d{2})", str(val))
            if m:
                return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return None


def nominatim_search(query, lang=None):
    """调用 Nominatim 搜索，返回第一个结果 dict 或 None。"""
    url = ("https://nominatim.openstreetmap.org/search?format=json&limit=1&q="
           + urllib.parse.quote(query))
    if lang:
        url += "&accept-language=" + lang
    req = urllib.request.Request(url, headers={"User-Agent": "photomap-site/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        results = json.loads(r.read().decode())
    time.sleep(1.1)  # Nominatim 要求每秒最多 1 次请求
    return results[0] if results else None


def geocode(name, cache):
    """地名 -> (lat, lng)，结果缓存到 geocache.json。"""
    if name in cache:
        return tuple(cache[name]) if cache[name] else None
    try:
        result = nominatim_search(name)
    except Exception as e:
        print(f"  地理编码请求失败 ({name}): {e}", file=sys.stderr)
        return None
    if result:
        coords = (round(float(result["lat"]), 6), round(float(result["lon"]), 6))
        cache[name] = list(coords)
        return coords
    cache[name] = None  # 缓存失败结果，避免反复请求
    return None


def english_name(location, coords, cache):
    """坐标 -> 英文地名（反向地理编码）。原名为纯 ASCII 时视为已是英文，返回 None。"""
    if not location or location.isascii():
        return None
    key = f"en:{coords[0]:.4f},{coords[1]:.4f}"
    if key in cache:
        return cache[key]
    url = (f"https://nominatim.openstreetmap.org/reverse?format=json"
           f"&lat={coords[0]}&lon={coords[1]}&zoom=14&accept-language=en")
    req = urllib.request.Request(url, headers={"User-Agent": "photomap-site/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            result = json.loads(r.read().decode())
        time.sleep(1.1)
    except Exception as e:
        print(f"  英文地名请求失败 ({location}): {e}", file=sys.stderr)
        return None
    # 取市级 + 省/都道府县级英文名，去重；均为 ASCII 时才采用
    addr = result.get("address", {})
    parts = []
    for keys in (("city", "town", "village", "municipality", "county"),
                 ("state", "province", "prefecture", "region")):
        for k in keys:
            v = addr.get(k)
            if v and v.isascii() and v not in parts:
                parts.append(v)
                break
    en = ", ".join(parts) if parts else None
    cache[key] = en
    return en


def make_thumb(src, dst):
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return
    with Image.open(src) as img:
        img = img.convert("RGB")
        img.thumbnail((THUMB_SIZE, THUMB_SIZE))
        img.save(dst, "JPEG", quality=75)


def main():
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    overrides = load_json(OVERRIDES_FILE, {})
    cache = load_json(GEOCACHE_FILE, {})

    entries = []
    files = sorted(p for p in PHOTOS_DIR.iterdir()
                   if p.is_file() and p.suffix.lower() in EXTS)
    for f in files:
        print(f"处理 {f.name} ...")
        location, date, caption = parse_filename(f.stem)

        with Image.open(f) as img:
            exif = exif_data(img)

        # 日期：文件名优先，其次 EXIF
        if not date:
            date = exif_date(exif)

        # 坐标：overrides > EXIF GPS > 地名地理编码
        coords = None
        ov = overrides.get(f.name)
        if ov and "lat" in ov and "lng" in ov:
            coords = (ov["lat"], ov["lng"])
            print("  坐标来自 overrides.json")
        if coords is None:
            coords = exif_gps(exif)
            if coords:
                print("  坐标来自 EXIF GPS")
        if coords is None and location:
            coords = geocode(location, cache)
            if coords:
                print(f"  坐标来自地理编码: {coords}")
        if coords is None:
            print(f"  ⚠️ 无法确定坐标，已跳过。请在 overrides.json 中为 "
                  f"\"{f.name}\" 手动填写 lat/lng。", file=sys.stderr)
            continue

        # overrides 也可以覆盖文字信息
        loc_en = None
        if ov:
            location = ov.get("location", location)
            date = ov.get("date", date)
            caption = ov.get("caption", caption)
            loc_en = ov.get("location_en")

        # 地点英文名：overrides 优先，否则从 Nominatim 获取（原名已是英文则为 None）
        if loc_en is None:
            loc_en = english_name(location, coords, cache)
            if loc_en:
                print(f"  英文地名: {loc_en}")

        thumb = THUMBS_DIR / (f.stem + ".jpg")
        make_thumb(f, thumb)

        entries.append({
            "file": f"photos/{f.name}",
            "thumb": f"photos/thumbs/{thumb.name}",
            "lat": coords[0],
            "lng": coords[1],
            "date": date,
            "location": location,
            "location_en": loc_en,
            "caption": caption,
        })

    entries.sort(key=lambda e: e["date"] or "", reverse=True)
    OUTPUT_JSON.write_text(json.dumps(entries, ensure_ascii=False, indent=2),
                           encoding="utf-8")
    GEOCACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=2),
                             encoding="utf-8")
    print(f"\n完成: {len(entries)} 张照片写入 photos.json")


if __name__ == "__main__":
    main()
