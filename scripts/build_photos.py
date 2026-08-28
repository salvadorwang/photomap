#!/usr/bin/env python3
"""
扫描 photos/ 下的照片，自动生成 photos.json 和缩略图。

文件名约定：
    地点.jpg               例如: 男木岛.jpg
    同一地点多张照片时加数字后缀区分，会自动忽略:
    男木岛2.jpg / 男木岛_2.jpg / 男木岛 (2).jpg
    （也兼容旧格式 地点_YYYY-MM-DD_说明.jpg，文件名中的日期/说明优先生效）

拍摄日期来源优先级：
    1. overrides.json 中手动指定
    2. 已生成的 photos.json 中该文件的日期（保持稳定，避免 CI 重算时漂移）
    3. 本地运行: 文件创建时间；GitHub Actions 中: 该文件首次加入 git 的日期
       （git checkout 不保留文件创建时间，CI 里直接读会全变成构建当天）

坐标来源优先级：
    1. overrides.json 中手动指定的坐标（键为文件名）
    2. 照片 EXIF 中的 GPS 信息
    3. 用文件名中的地点名称调用 Nominatim (OpenStreetMap) 地理编码

用法:  python3 scripts/build_photos.py
依赖:  pip install Pillow
"""

import json
import os
import re
import subprocess
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageOps, ExifTags

try:
    from pillow_heif import register_heif_opener
    register_heif_opener()          # 让 Pillow 认识 HEIC/HEIF (iPhone 默认格式)
    HEIC_OK = True
except ImportError:
    HEIC_OK = False

ROOT = Path(__file__).resolve().parent.parent
PHOTOS_DIR = ROOT / "photos"
THUMBS_DIR = PHOTOS_DIR / "thumbs"
DISPLAY_DIR = PHOTOS_DIR / "display"
OUTPUT_JSON = ROOT / "photos.json"
OVERRIDES_FILE = ROOT / "overrides.json"
GEOCACHE_FILE = ROOT / "scripts" / "geocache.json"

THUMB_SIZE = 128          # 缩略图最长边像素
DISPLAY_SIZE = 2000       # 网页展示大图最长边像素（原图太大，直接加载很慢）
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
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
    # 去掉同名照片的数字后缀: 男木岛2 / 男木岛_2 / 男木岛 (2) / 男木岛-2
    stem = re.sub(r"[\s_\-]*\(?\d+\)?$", "", stem).strip() or stem
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


def file_date(path):
    """文件生成日期。CI 中文件系统时间不可靠，改用该文件首次进入 git 的日期。"""
    if os.environ.get("GITHUB_ACTIONS"):
        try:
            out = subprocess.run(
                ["git", "log", "--follow", "--diff-filter=A", "--format=%aI", "-1",
                 "--", str(path.relative_to(ROOT))],
                capture_output=True, text=True, cwd=ROOT, check=False).stdout.strip()
            if out:
                return out.splitlines()[-1][:10]
        except Exception:
            pass
    st = path.stat()
    ts = getattr(st, "st_birthtime", None) or st.st_mtime
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def exif_data(img):
    """读 EXIF（getexif 对 JPEG/HEIC 都有效；_getexif 只支持 JPEG）。"""
    try:
        ex = img.getexif()
    except Exception:
        return {}
    if not ex:
        return {}
    data = {ExifTags.TAGS.get(k, k): v for k, v in ex.items()}
    try:
        gps = ex.get_ifd(ExifTags.IFD.GPSInfo)
        if gps:
            data["GPSInfo"] = dict(gps)
    except Exception:
        pass
    return data


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


def country_name(coords, cache):
    """坐标 -> 英文国家名（粗粒度反向地理编码，结果缓存）。"""
    key = f"country:{coords[0]:.2f},{coords[1]:.2f}"
    if key in cache:
        return cache[key]
    url = (f"https://nominatim.openstreetmap.org/reverse?format=json"
           f"&lat={coords[0]}&lon={coords[1]}&zoom=3&accept-language=en")
    req = urllib.request.Request(url, headers={"User-Agent": "photomap-site/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            result = json.loads(r.read().decode())
        time.sleep(1.1)
    except Exception as e:
        print(f"  国家名请求失败: {e}", file=sys.stderr)
        return None
    country = (result.get("address") or {}).get("country")
    if country and not country.isascii():
        country = None
    cache[key] = country
    return country


def resize_to(src, dst, max_side, quality):
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return
    with Image.open(src) as img:
        img = ImageOps.exif_transpose(img)  # 按 EXIF 方向摆正，避免竖拍照片横躺
        img = img.convert("RGB")
        img.thumbnail((max_side, max_side))
        img.save(dst, "JPEG", quality=quality)


def main():
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    DISPLAY_DIR.mkdir(parents=True, exist_ok=True)
    # 文件名统一 NFC 规范化：macOS 文件名是 NFD，直接比较会匹配不上带重音符的键
    overrides = {unicodedata.normalize("NFC", k): v
                 for k, v in load_json(OVERRIDES_FILE, {}).items()}
    cache = load_json(GEOCACHE_FILE, {})
    # 上次生成的日期，用于保持稳定（键用原图路径，统一 NFC：
    # macOS 文件系统给 NFD、git 提交转成 NFC，不归一会匹配不上）
    nfc = lambda s: unicodedata.normalize("NFC", s)
    prev_dates = {nfc(e.get("original") or e["file"]): e.get("date")
                  for e in load_json(OUTPUT_JSON, [])}

    entries = []
    files = sorted(p for p in PHOTOS_DIR.iterdir()
                   if p.is_file() and p.suffix.lower() in EXTS)
    for f in files:
        if f.suffix.lower() in {".heic", ".heif"} and not HEIC_OK:
            print(f"⚠️ 跳过 {f.name}: 读取 HEIC 需要安装 pillow-heif "
                  f"(pip install pillow-heif)", file=sys.stderr)
            continue
        print(f"处理 {f.name} ...")
        location, date, caption = parse_filename(unicodedata.normalize("NFC", f.stem))

        with Image.open(f) as img:
            exif = exif_data(img)

        # 日期：文件名中显式给出 > 上次生成结果 > 文件生成日期
        if not date:
            date = prev_dates.get(nfc(f"photos/{f.name}")) or file_date(f)

        # 坐标：overrides > EXIF GPS > 地名地理编码
        coords = None
        ov = overrides.get(unicodedata.normalize("NFC", f.name))
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

        # 所在国家（英文，用于前端国家筛选菜单）
        country = (ov or {}).get("country") or country_name(coords, cache)
        if country:
            print(f"  国家: {country}")

        thumb = THUMBS_DIR / (f.stem + ".jpg")
        resize_to(f, thumb, THUMB_SIZE, 75)
        display = DISPLAY_DIR / (f.stem + ".jpg")
        resize_to(f, display, DISPLAY_SIZE, 82)

        entries.append({
            "file": nfc(f"photos/display/{display.name}"),
            "original": nfc(f"photos/{f.name}"),
            "thumb": nfc(f"photos/thumbs/{thumb.name}"),
            "lat": coords[0],
            "lng": coords[1],
            "date": date,
            "location": location,
            "location_en": loc_en,
            "country": country,
            "caption": caption,
        })

    # 清理源图已删除的孤儿缩略图/展示图
    stems = {f.stem for f in files}
    for d in (THUMBS_DIR, DISPLAY_DIR):
        for t in d.glob("*.jpg"):
            if t.stem not in stems:
                t.unlink()
                print(f"清理孤儿文件 {t.relative_to(ROOT)}")

    entries.sort(key=lambda e: e["date"] or "", reverse=True)
    OUTPUT_JSON.write_text(json.dumps(entries, ensure_ascii=False, indent=2),
                           encoding="utf-8")
    GEOCACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=2),
                             encoding="utf-8")
    print(f"\n完成: {len(entries)} 张照片写入 photos.json")


if __name__ == "__main__":
    main()
