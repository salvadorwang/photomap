/* 照片地图主逻辑：Leaflet 平面地图 + globe.gl 地球仪，按钮切换 */

let photos = [];
let map = null;        // Leaflet（默认视图）
let globe = null;      // globe.gl（首次切换到 3D 时才初始化）
let showingGlobe = false;
let countriesGeo = null;   // 国家边界 GeoJSON（仅用于国家跳转的范围计算）
let mapMarkers = [];       // 2D 标记登记表（防重叠用）
let globeMarkers = [];     // 3D 标记登记表

const $ = (id) => document.getElementById(id);

init();

async function init() {
  // 被主站 iframe 嵌入时隐藏自己的标题栏（保留切换按钮，挪到地图角上）
  if (new URLSearchParams(location.search).has('embed')) {
    document.body.classList.add('embedded');
    document.getElementById('stage').appendChild(document.getElementById('toggle-view'));
  }
  try {
    const [photosRes, countriesRes] = await Promise.all([
      fetch('photos.json?t=' + Date.now()),
      fetch('data/countries.geojson')
    ]);
    photos = await photosRes.json();
    countriesGeo = await countriesRes.json();
  } catch (e) {
    console.error('Failed to load data', e);
    photos = photos || [];
  }
  $('photo-count').textContent = `${photos.length} photo${photos.length === 1 ? '' : 's'}`;

  initCountrySelect();
  $('gz-in').addEventListener('click', () => zoomGlobe(0.6));
  $('gz-out').addEventListener('click', () => zoomGlobe(1 / 0.6));

  initMap();

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
  } else {
    map.flyToBounds([[b.minLat, b.minLng], [b.maxLat, b.maxLng]], { padding: [30, 30], duration: 1.2 });
  }
}

/* ============================================================
 * 缩略图防重叠：放大到国家级视野后，把互相压住的缩略图推开，
 * 并用一条带箭头的引线指回它真实的地理位置。
 * ============================================================ */
const THUMB = 48;              // 缩略图边长
const GAP = 7;                 // 缩略图之间的最小间隙
// 一旦偏移，至少离开锚点一个身位：斜向时缩略图半对角线约 34px，
// 再加箭头 9px 才够画，取 52 让任意方向都留得出引线
const MIN_OFF = THUMB + 4;
const MAX_OFF = 150;           // 单张最大偏移量（px）
const DECLUTTER_ZOOM = 4;      // 2D：达到该缩放级别起生效（≈ 点击国家跳转后的视野）
const DECLUTTER_ALT = 1.0;     // 3D：视角高度低于该值起生效（越小越近）

const LEADER_SVG =
  '<svg class="pm-leader" width="420" height="420" viewBox="-210 -210 420 420">' +
  '<path class="pm-halo"></path><path class="pm-line"></path><path class="pm-arrow"></path></svg>';

// 生成一个「零尺寸锚点 + 可偏移缩略图 + 引线」的标记节点
function createMarkerNode(p) {
  const wrap = document.createElement('div');
  wrap.className = 'pm-anchor';
  wrap.innerHTML = LEADER_SVG;
  const img = document.createElement('img');
  img.className = 'pm-thumb';
  img.src = p.thumb;
  img.width = THUMB;
  img.height = THUMB;
  img.title = displayLocation(p);
  img.alt = displayLocation(p);
  img.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(p); });
  wrap.appendChild(img);
  return { photo: p, wrap, img, svg: wrap.querySelector('.pm-leader'), x: 0, y: 0, dx: 0, dy: 0 };
}

// 迭代分离：每次沿「穿透最浅的那根轴」把两个方框推开，位移最小、排布最整齐
function separate(items, iterations) {
  const size = THUMB + GAP;
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        let dx = (b.x + b.dx) - (a.x + a.dx);
        let dy = (b.y + b.dy) - (a.y + a.dy);
        if (dx === 0 && dy === 0) {          // 完全重合时给个确定的分离方向
          dx = Math.cos(i * 1.7 + j * 0.9) * 0.1;
          dy = Math.sin(i * 1.7 + j * 0.9) * 0.1;
        }
        const ox = size - Math.abs(dx);
        const oy = size - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;    // 不重叠
        moved = true;
        if (ox < oy) {
          const push = (ox / 2 + 0.5) * (dx < 0 ? -1 : 1);
          a.dx -= push; b.dx += push;
        } else {
          const push = (oy / 2 + 0.5) * (dy < 0 ? -1 : 1);
          a.dy -= push; b.dy += push;
        }
      }
    }
    if (!moved) break;
  }
}

// 该缩略图在当前位置是否真的压住了别人（按图片实际尺寸判定，不含间隙）
function collides(it, items) {
  for (const o of items) {
    if (o === it) continue;
    if (Math.abs((o.x + o.dx) - (it.x + it.dx)) < THUMB &&
        Math.abs((o.y + o.dy) - (it.y + it.dy)) < THUMB) return true;
  }
  return false;
}

// 位移不足一个身位的：能归零就归零（省得平白挪动），归零会压住别人就推足
function snapShortOffsets(items) {
  let adjusted = false;
  for (const it of items) {
    const len = Math.hypot(it.dx, it.dy);
    if (len === 0 || len >= MIN_OFF) continue;
    adjusted = true;
    const ox = it.dx, oy = it.dy;
    it.dx = 0; it.dy = 0;
    if (collides(it, items)) { it.dx = ox * MIN_OFF / len; it.dy = oy * MIN_OFF / len; }
  }
  return adjusted;
}

function resolveOverlaps(items) {
  for (const it of items) { it.dx = 0; it.dy = 0; }
  separate(items, 140);
  // 位移过小的：要么归零（几像素的重叠根本看不出来），要么推到一个身位以外，
  // 好让引线和箭头有地方可画——不留「挪了却看不出挪去哪」的中间状态。
  // 推开后可能又产生新的重叠，所以「归位—再分离」交替几轮直到稳定。
  for (let round = 0; round < 5; round++) {
    if (!snapShortOffsets(items)) break;
    separate(items, 60);
  }
  // 收尾只做「能归零就归零」，不再往外推，免得推出新的重叠没人收拾
  for (const it of items) {
    const len = Math.hypot(it.dx, it.dy);
    if (len === 0 || len >= MIN_OFF) continue;
    const ox = it.dx, oy = it.dy;
    it.dx = 0; it.dy = 0;
    if (collides(it, items)) { it.dx = ox; it.dy = oy; }
  }
  for (const it of items) {
    const len = Math.hypot(it.dx, it.dy);
    if (len > MAX_OFF) { it.dx *= MAX_OFF / len; it.dy *= MAX_OFF / len; }
    it.dx = Math.round(it.dx); it.dy = Math.round(it.dy);
  }
}

// 画引线：从缩略图边缘连到锚点，末端一个小箭头指着真实位置
function drawLeader(m) {
  const { svg, dx, dy } = m;
  const len = Math.hypot(dx, dy);
  const AL = 9, AW = 3.3;                                          // 箭头长 / 半宽
  const ux = dx / len, uy = dy / len;
  const half = THUMB / 2;
  const s = Math.min(half / Math.abs(ux), half / Math.abs(uy));   // 缩略图边框交点距中心的距离
  // 锚点还在缩略图底下（或刚好贴着），画了也看不见，直接省略
  if (!len || len < s + AL + 2) { svg.style.display = 'none'; return; }
  svg.style.display = '';
  const ex = dx - ux * s, ey = dy - uy * s;
  const bx = ux * AL, by = uy * AL;
  const d = `M${bx.toFixed(1)} ${by.toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}`;
  svg.querySelector('.pm-halo').setAttribute('d', d);
  svg.querySelector('.pm-line').setAttribute('d', d);
  const px = -uy * AW, py = ux * AW;
  svg.querySelector('.pm-arrow').setAttribute('d',
    `M0 0L${(bx + px).toFixed(1)} ${(by + py).toFixed(1)}L${(bx - px).toFixed(1)} ${(by - py).toFixed(1)}Z`);
}

function applyOffset(m) {
  m.img.style.transform = `translate(-50%,-50%) translate(${m.dx}px,${m.dy}px)`;
  drawLeader(m);
}

function layoutMapMarkers() {
  if (!map || !mapMarkers.length) return;
  const active = map.getZoom() >= DECLUTTER_ZOOM;
  const size = map.getSize();
  const items = [];
  for (const m of mapMarkers) {
    m.dx = 0; m.dy = 0;
    const pt = map.latLngToContainerPoint([m.photo.lat, m.photo.lng]);
    m.x = pt.x; m.y = pt.y;
    if (active && pt.x > -220 && pt.x < size.x + 220 && pt.y > -220 && pt.y < size.y + 220) {
      items.push(m);
    }
  }
  if (active) resolveOverlaps(items);
  mapMarkers.forEach(applyOffset);
}

// 单位球面向量，用于判断某点是否在地球正面
function unitVec(lat, lng) {
  const a = lat * Math.PI / 180, b = lng * Math.PI / 180;
  return [Math.cos(a) * Math.cos(b), Math.sin(a), Math.cos(a) * Math.sin(b)];
}

function layoutGlobeMarkers() {
  if (!globe || !globeMarkers.length) return;
  const pov = globe.pointOfView();
  const active = pov.altitude <= DECLUTTER_ALT;
  const cosLimit = 1 / (1 + pov.altitude);      // 球面地平线夹角
  const c = unitVec(pov.lat, pov.lng);
  const items = [];
  for (const m of globeMarkers) {
    m.dx = 0; m.dy = 0;
    if (!active) continue;
    const v = unitVec(m.photo.lat, m.photo.lng);
    if (v[0] * c[0] + v[1] * c[1] + v[2] * c[2] <= cosLimit) continue;   // 在地球背面
    const sc = globe.getScreenCoords(m.photo.lat, m.photo.lng, 0.01);
    if (!sc) continue;
    m.x = sc.x; m.y = sc.y;
    items.push(m);
  }
  if (active) resolveOverlaps(items);
  globeMarkers.forEach(applyOffset);
}

// 相机动起来时持续重排（含程序化飞行动画），视角没变就跳过
let lastPov = '';
function globeLayoutLoop() {
  if (globe && showingGlobe) {
    const p = globe.pointOfView();
    const key = `${p.lat.toFixed(3)},${p.lng.toFixed(3)},${p.altitude.toFixed(4)}`;
    if (key !== lastPov) { lastPov = key; layoutGlobeMarkers(); }
  }
  requestAnimationFrame(globeLayoutLoop);
}

/* ---------- 平面地图 (Leaflet) ---------- */
function initMap() {
  // 最小缩放随容器高度算出，保证世界地图始终铺满、上下不留黑边
  const el = $('map');
  const minZoom = Math.max(2, Math.ceil(Math.log2(Math.max(el.clientHeight, 256) / 256)));
  map = L.map('map', {
    worldCopyJump: true, zoomControl: false, minZoom,
    // 纵向钳在世界地图范围内（消除上下黑边），横向仍可跨日期变更线平移
    maxBounds: [[-85.06, -36000], [85.06, 36000]],
    maxBoundsViscosity: 1.0
  }).setView([25, 115], Math.max(3, minZoom));
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);

  mapMarkers = photos.map((p) => {
    const m = createMarkerNode(p);
    L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: '', html: m.wrap, iconSize: [0, 0], iconAnchor: [0, 0] })
    }).addTo(map);
    return m;
  });
  map.on('zoomend moveend resize', layoutMapMarkers);

  if (photos.length > 0) {
    const bounds = L.latLngBounds(photos.map((p) => [p.lat, p.lng]));
    map.fitBounds(bounds.pad(0.3), { maxZoom: 6 });
  }
  layoutMapMarkers();
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
      const m = createMarkerNode(p);
      globeMarkers = globeMarkers.filter((x) => x.photo !== p);   // 防止重建时重复登记
      globeMarkers.push(m);
      return m.wrap;
    });

  globe.controls().autoRotate = false;   // 不自动旋转，仅手动拖动
  // 视网膜屏按物理像素渲染，否则贴图和文字发虚
  globe.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  if (photos.length > 0) {
    globe.pointOfView({ lat: photos[0].lat, lng: photos[0].lng, altitude: 2 }, 1500);
  }
  resizeGlobe();
  window.addEventListener('resize', resizeGlobe);
  requestAnimationFrame(globeLayoutLoop);
}

function zoomGlobe(factor) {
  if (!showingGlobe || !globe) return;
  const pov = globe.pointOfView();
  const altitude = Math.min(Math.max(pov.altitude * factor, 0.12), 4);
  globe.pointOfView({ lat: pov.lat, lng: pov.lng, altitude }, 350);
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
