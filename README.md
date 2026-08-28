# 📷 照片地图 (Photo Map)

个人照片展示网站：世界地图 / 地球仪上按拍摄地点显示照片缩略图，点击查看大图和详细信息。托管于 GitHub Pages，无后端。

## 添加照片的方法

1. 把照片放进 `photos/` 文件夹，按以下格式命名（下划线分隔）：

   ```
   地点_日期_说明.jpg        例: 东京涩谷_2025-03-12_樱花季.jpg
   地点_日期.jpg             例: 仙台_2025-06-01.jpg
   地点.jpg                 （日期从照片 EXIF 中读取）
   ```

2. `git add photos/ && git commit -m "add photos" && git push`

3. GitHub Actions 会自动：解析文件名 → 地名转坐标（照片自带 GPS 则优先用 GPS）→ 生成缩略图 → 更新 `photos.json` → 部署网站。约 1 分钟后生效。

## 手动修正坐标

自动定位不准时，在 `overrides.json` 中按文件名指定坐标（也可覆盖地点名/日期/说明）：

```json
{
  "东京涩谷_2025-03-12_樱花季.jpg": {
    "lat": 35.6595,
    "lng": 139.7005,
    "location": "东京·涩谷"
  }
}
```

## 本地预览

```bash
python3 scripts/build_photos.py      # 需要 pip install Pillow
python3 -m http.server 8642
# 打开 http://localhost:8642
```

## 技术栈

- 平面地图：[Leaflet.js](https://leafletjs.com/) + OpenStreetMap 底图
- 地球仪：[globe.gl](https://globe.gl/)
- 地理编码：[Nominatim](https://nominatim.org/) (OpenStreetMap)
- 数据：静态 `photos.json`，由 `scripts/build_photos.py` 生成
- 自动化：GitHub Actions（见 `.github/workflows/deploy.yml`）
