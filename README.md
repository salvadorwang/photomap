# 📷 照片地图 (Photo Map)

个人照片展示网站：世界地图 / 地球仪上按拍摄地点显示照片缩略图，点击查看大图和详细信息。托管于 GitHub Pages，无后端。

## 添加照片的方法

1. 把照片放进 `photos/` 文件夹，文件名就是拍摄地点名：

   ```
   男木岛.jpg
   男木岛_2.jpg      （同一地点多张时加数字后缀，后缀会自动忽略）
   ```

   拍摄日期自动取照片文件的创建时间；也兼容旧格式 `地点_YYYY-MM-DD_说明.jpg`（文件名中的日期/说明优先生效）。

2. `git add photos/ && git commit -m "add photos" && git push`

3. GitHub Actions 会自动：地名转坐标（照片自带 EXIF GPS 则优先用 GPS）→ 读取日期 → 生成缩略图 → 更新 `photos.json` → 部署网站。约 1 分钟后生效。

   > 日期细节：git 不保存文件创建时间，所以 CI 里对新照片改用"首次加入 git 的日期"。想让网站用照片在你电脑上的真实创建日期，把照片放入后本地跑一次 `python3 scripts/build_photos.py`，再连同生成的 `photos.json` 一起提交推送即可（已生成过的日期之后不会被 CI 改动）。

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
