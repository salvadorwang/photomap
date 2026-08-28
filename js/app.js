/* 照片地图主逻辑：Leaflet 平面地图 + globe.gl 地球仪，按钮切换 */

let photos = [];
let map = null;        // Leaflet（首次切换到 2D 时才初始化）
let globe = null;      // globe.gl（默认视图）
let showingGlobe = true;
let countriesGeo = null;   // 国家边界 GeoJSON（Natural Earth 110m）
let cityLabels = [];       // 主要城市标签（放大后显示）
let countryLabels = [];    // 国家名标签
let citiesShown = false;

const $ = (id) => document.getElementById(id);

init();

async function init() {
  // 被主站 iframe 嵌入时隐藏自己的标题栏（保留切换按钮，挪到地图角上）
  if (new URLSearchParams(location.search).has('embed')) {
    document.body.classList.add('embedded');
    document.getElementById('stage').appendChild(document.getElementById('toggle-view'));
  }
  try {
    const [photosRes, countriesRes, citiesRes] = await Promise.all([
      fetch('photos.json?t=' + Date.now()),
      fetch('data/countries.geojson'),
      fetch('data/cities.geojson')
    ]);
    photos = await photosRes.json();
    countriesGeo = await countriesRes.json();
    const cities = await citiesRes.json();
    cityLabels = cities.features.map((f) => ({
      lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
      text: asciiName(f.properties.name), city: true
    }));
    countryLabels = countriesGeo.features.map((f) => {
      const c = featureLabelPoint(f);
      return { lat: c[1], lng: c[0], text: asciiName(f.properties.NAME), city: false };
    });
  } catch (e) {
    console.error('Failed to load data', e);
    photos = photos || [];
  }
  $('photo-count').textContent = `${photos.length} photo${photos.length === 1 ? '' : 's'}`;

  initCountrySelect();
  $('gz-in').addEventListener('click', () => zoomGlobe(0.6));
  $('gz-out').addEventListener('click', () => zoomGlobe(1 / 0.6));

  initGlobe();

  $('toggle-view').addEventListener('click', toggleView);
  $('lightbox-close').addEventListener('click', closeLightbox);
  $('lightbox-backdrop').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
}

/* ---------- 地理工具 ---------- */
// 提取一个国家 feature 的所有多边形环（Polygon/MultiPolygon 的外环）
function featureRings(f) {
  const g = f.geometry;
  return g.type === 'Polygon' ? [g.coordinates[0]]
       : g.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : [];
}

// 标签位置：取面积最大的环（本土）的包围盒中心
function featureLabelPoint(f) {
  let best = null, bestArea = -1;
  for (const ring of featureRings(f)) {
    let minX = 180, maxX = -180, minY = 90, maxY = -90;
    for (const [x, y] of ring) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const area = (maxX - minX) * (maxY - minY);
    if (area > bestArea) { bestArea = area; best = [(minX + maxX) / 2, (minY + maxY) / 2]; }
  }
  return best || [0, 0];
}

// 国家主体包围盒：跳过离主体中心太远的环（阿拉斯加、夏威夷、海外领地等），
// 经度以标签点为参考展开，正确处理跨 180° 经线的国家
function featureBounds(f) {
  const [refLng, refLat] = featureLabelPoint(f);
  const norm = (x) => { let d = x - refLng; while (d > 180) d -= 360; while (d < -180) d += 360; return refLng + d; };
  let minX = Infinity, maxX = -Infinity, minY = 90, maxY = -90;
  for (const ring of featureRings(f)) {
    let rMinX = Infinity, rMaxX = -Infinity, rMinY = 90, rMaxY = -90;
    for (const [x, y] of ring) {
      const nx = norm(x);
      if (nx < rMinX) rMinX = nx; if (nx > rMaxX) rMaxX = nx;
      if (y < rMinY) rMinY = y; if (y > rMaxY) rMaxY = y;
    }
    const cx = (rMinX + rMaxX) / 2, cy = (rMinY + rMaxY) / 2;
    if (Math.abs(cx - refLng) > 25 || Math.abs(cy - refLat) > 20) continue;  // 远离主体，不计入
    if (rMinX < minX) minX = rMinX; if (rMaxX > maxX) maxX = rMaxX;
    if (rMinY < minY) minY = rMinY; if (rMaxY > maxY) maxY = rMaxY;
  }
  return { minLat: minY, maxLat: maxY, minLng: minX, maxLng: maxX };
}

// 标签字体只含基础拉丁字母，去掉变音符（Ōsaka -> Osaka, São Paulo -> Sao Paulo）
function asciiName(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function findCountryFeature(name) {
  if (!countriesGeo) return null;
  const n = name.toLowerCase();
  return countriesGeo.features.find((f) => {
    const p = f.properties;
    return [p.NAME, p.NAME_LONG, p.ADMIN].some((v) => {
      if (!v) return false;
      const w = v.toLowerCase();
      return w === n || w.includes(n) || n.includes(w);
    });
  });
}

/* ---------- 国家下拉菜单 ---------- */
function initCountrySelect() {
  const sel = $('country-select');
  const countries = [...new Set(photos.map((p) => p.country).filter(Boolean))].sort();
  sel.innerHTML = '<option value="" selected>Country</option>'
    + countries.map((c) => `<option value="${c}">${c}</option>`).join('');
  sel.addEventListener('change', () => { if (sel.value) flyToCountry(sel.value); });
}

function flyToCountry(name) {
  const f = findCountryFeature(name);
  let b;
  if (f) {
    b = featureBounds(f);
  } else {
    // 边界数据里找不到就退回用该国照片的范围
    const pts = photos.filter((p) => p.country === name);
    if (!pts.length) return;
    b = {
      minLat: Math.min(...pts.map((p) => p.lat)) - 2, maxLat: Math.max(...pts.map((p) => p.lat)) + 2,
      minLng: Math.min(...pts.map((p) => p.lng)) - 2, maxLng: Math.max(...pts.map((p) => p.lng)) + 2
    };
  }
  if (showingGlobe) {
    const span = Math.max(b.maxLat - b.minLat, (b.maxLng - b.minLng) * 0.7);
    const altitude = Math.min(Math.max(span / 50, 0.4), 2.5);
    globe.pointOfView({ lat: (b.minLat + b.maxLat) / 2, lng: (b.minLng + b.maxLng) / 2, altitude }, 1200);
    setTimeout(() => refreshLabels(false), 1300);
  } else {
    map.flyToBounds([[b.minLat, b.minLng], [b.maxLat, b.maxLng]], { padding: [30, 30], duration: 1.2 });
  }
}

/* ---------- 平面地图 (Leaflet) ---------- */
function initMap() {
  map = L.map('map', { worldCopyJump: true, zoomControl: false }).setView([25, 115], 3);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);

  photos.forEach((p) => {
    const icon = L.divIcon({
      className: '',
      html: `<img class="photo-marker" src="${p.thumb}" width="48" height="48" title="${displayLocation(p)}" alt="${displayLocation(p)}">`,
      iconSize: [48, 48],
      iconAnchor: [24, 24]
    });
    L.marker([p.lat, p.lng], { icon })
      .addTo(map)
      .on('click', () => openLightbox(p));
  });

  if (photos.length > 0) {
    const bounds = L.latLngBounds(photos.map((p) => [p.lat, p.lng]));
    map.fitBounds(bounds.pad(0.3), { maxZoom: 6 });
  }
}

/* ---------- 地球仪 (globe.gl) ---------- */
function initGlobe() {
  const el = $('globe');
  globe = Globe({ rendererConfig: { antialias: true } })(el)
    .globeImageUrl('data/earth-texture.jpg')
    .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
    .htmlElementsData(photos)
    .htmlLat('lat')
    .htmlLng('lng')
    .htmlAltitude(0.01)
    .htmlElement((p) => {
      const img = document.createElement('img');
      img.src = p.thumb;
      img.className = 'globe-thumb';
      img.title = displayLocation(p);
      img.style.pointerEvents = 'auto';
      img.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(p); });
      return img;
    });

  // 国家边界线 + 名称标签（贴图本身无文字）
  if (countriesGeo) {
    globe
      .polygonsData(countriesGeo.features)
      .polygonCapColor(() => 'rgba(0,0,0,0)')
      .polygonSideColor(() => 'rgba(0,0,0,0)')
      .polygonStrokeColor(() => 'rgba(255,255,255,0.5)')
      .polygonAltitude(0.002)
      .polygonsTransitionDuration(0)
      .labelLat('lat').labelLng('lng').labelText('text')
      .labelSize((d) => d.city ? 0.55 : 0.9)
      .labelDotRadius((d) => d.city ? 0.12 : 0)
      .labelColor((d) => d.city ? 'rgba(255,225,160,0.95)' : 'rgba(255,255,255,0.85)')
      .labelAltitude(0.004)
      .labelResolution(2);
    refreshLabels(true);
    // 放大到一定程度后追加显示主要城市名
    globe.controls().addEventListener('change', () => refreshLabels(false));
  }

  globe.controls().autoRotate = false;   // 不自动旋转，仅手动拖动
  // 视网膜屏按物理像素渲染，否则贴图和文字发虚
  globe.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  if (photos.length > 0) {
    globe.pointOfView({ lat: photos[0].lat, lng: photos[0].lng, altitude: 2 }, 1500);
  }
  resizeGlobe();
  window.addEventListener('resize', resizeGlobe);
}

let lastLabelAlt = 2;

function refreshLabels(force) {
  const alt = globe.pointOfView().altitude;
  const showCities = alt < 1.0;
  const altChanged = Math.abs(alt - lastLabelAlt) / lastLabelAlt > 0.12;
  if (!force && showCities === citiesShown && !altChanged) return;
  citiesShown = showCities;
  lastLabelAlt = alt;
  // 标签是 3D 物体，放大时会跟着变大；按视角高度反向缩放，让屏幕字号基本恒定
  const k = Math.min(Math.max(alt / 2, 0.1), 1.25);
  globe
    .labelSize((d) => (d.city ? 0.55 : 0.9) * k)
    .labelDotRadius((d) => (d.city ? 0.12 : 0) * k)
    .labelsData(showCities ? countryLabels.concat(cityLabels) : countryLabels);
}

function zoomGlobe(factor) {
  if (!showingGlobe || !globe) return;
  const pov = globe.pointOfView();
  const altitude = Math.min(Math.max(pov.altitude * factor, 0.12), 4);
  globe.pointOfView({ lat: pov.lat, lng: pov.lng, altitude }, 350);
  setTimeout(() => refreshLabels(false), 400);
}

function resizeGlobe() {
  if (!globe) return;
  const el = $('globe');
  globe.width(el.clientWidth).height(el.clientHeight);
}

/* ---------- 切换 ---------- */
function toggleView() {
  showingGlobe = !showingGlobe;
  $('map').classList.toggle('hidden', showingGlobe);
  $('globe').classList.toggle('hidden', !showingGlobe);
  $('globe-zoom').classList.toggle('hidden', !showingGlobe);
  $('toggle-view').textContent = showingGlobe ? '🗺️ Map View' : '🌍 Globe View';

  if (showingGlobe) {
    if (!globe) initGlobe();
    else resizeGlobe();
  } else {
    if (!map) initMap();
    else map.invalidateSize();
  }
}

/* ---------- 大图弹窗 ---------- */
/* 地点显示：原名 (English)；原名本身是英文或两者相同时只显示原名 */
function displayLocation(p) {
  const orig = p.location || '';
  const en = p.location_en || '';
  if (!orig) return en || 'Unknown location';
  if (!en || en.toLowerCase() === orig.toLowerCase()) return orig;
  return `${orig} (${en})`;
}

function openLightbox(p) {
  $('lightbox-img').src = p.file;
  $('lb-location').textContent = displayLocation(p);
  $('lb-caption').textContent = p.caption || '';
  $('lb-date').textContent = p.date ? `📅 ${p.date}` : 'Date unknown';
  $('lb-coords').textContent = `📍 ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
  $('lightbox').classList.remove('hidden');
}

function closeLightbox() {
  $('lightbox').classList.add('hidden');
  $('lightbox-img').src = '';
}
