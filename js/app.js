/* 照片地图主逻辑：Leaflet 平面地图 + globe.gl 地球仪，按钮切换 */

let photos = [];
let map = null;        // Leaflet（首次切换到 2D 时才初始化）
let globe = null;      // globe.gl（默认视图）
let showingGlobe = true;

const $ = (id) => document.getElementById(id);

init();

async function init() {
  // 被主站 iframe 嵌入时隐藏自己的标题栏（保留切换按钮，挪到地图角上）
  if (new URLSearchParams(location.search).has('embed')) {
    document.body.classList.add('embedded');
    document.getElementById('stage').appendChild(document.getElementById('toggle-view'));
  }
  try {
    const res = await fetch('photos.json?t=' + Date.now());
    photos = await res.json();
  } catch (e) {
    console.error('Failed to load photos.json', e);
    photos = [];
  }
  $('photo-count').textContent = `${photos.length} photo${photos.length === 1 ? '' : 's'}`;

  initGlobe();

  $('toggle-view').addEventListener('click', toggleView);
  $('lightbox-close').addEventListener('click', closeLightbox);
  $('lightbox-backdrop').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
}

/* ---------- 平面地图 (Leaflet) ---------- */
function initMap() {
  map = L.map('map', { worldCopyJump: true }).setView([25, 115], 3);
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
  globe = Globe()(el)
    .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
    .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
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

  globe.controls().autoRotate = true;
  globe.controls().autoRotateSpeed = 0.6;

  if (photos.length > 0) {
    globe.pointOfView({ lat: photos[0].lat, lng: photos[0].lng, altitude: 2 }, 1500);
  }
  resizeGlobe();
  window.addEventListener('resize', resizeGlobe);
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
