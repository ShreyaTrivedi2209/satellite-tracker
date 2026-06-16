import * as THREE from 'three';

const EARTH_RADIUS_KM = 6371;
const POLL_INTERVAL_MS = 5000;
const ISS_NORAD = '25544';
const KM_SCALE = 1 / EARTH_RADIUS_KM;
const EARTH_MU_KM3_S2 = 398600.4418;
const CELESTRAK_2LE_URLS = [
  '/api/celestrak/NORAD/elements/gp.php?GROUP=active&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle',
];
const CELESTRAK_BROWSER_REFRESH_MIN_MS = 10 * 60 * 1000;
const EARTH_MAP_SRC = '/textures/00_earthmap1k.jpg';
const ORBIT_SAMPLE_COUNT = 160;
const ORBIT_VISIBLE_LIMIT = 24;
const ANALYTICS_TABLE_LIMIT = 200;
const ANALYTICS_HEATMAP_BINS = 14;

const ANALYTICS_FIELDS = [
  { key: 'altitude', label: 'Altitude km' },
  { key: 'latitude', label: 'Latitude' },
  { key: 'longitude', label: 'Longitude' },
  { key: 'inclination', label: 'Inclination' },
  { key: 'raan', label: 'RAAN' },
  { key: 'eccentricity', label: 'Eccentricity' },
  { key: 'argPerigee', label: 'Arg perigee' },
  { key: 'meanAnomaly', label: 'Mean anomaly' },
  { key: 'meanMotion', label: 'Mean motion' },
  { key: 'bstar', label: 'BSTAR' },
];

const DEFAULT_ANALYTICS = {
  chart: 'histogram',
  x: 'altitude',
  y: 'inclination',
};

const DEFAULT_FILTERS = {
  search: '',
  country: 'all',
  altitudeBand: 'all',
  inclination: [0, 180],
  eccentricityMax: 1,
  meanMotion: [0, 20],
  raan: [0, 360],
  argPerigee: [0, 360],
  meanAnomaly: [0, 360],
  bstarMax: 0.1,
  tleAgeMaxDays: 30,
};

export function ecefKmToThree(x, y, z) {
  const geo = ecefToGeodetic(x, y, z);
  return geodeticToThree(geo.lat, geo.lon, geo.alt);
}

function geodeticToThree(latDeg, lonDeg, altKm = 0) {
  const r = Math.max(0.001, 1 + altKm * KM_SCALE);
  const lat = THREE.MathUtils.degToRad(latDeg);
  const lon = THREE.MathUtils.degToRad(lonDeg);
  const cosLat = Math.cos(lat);

  return new THREE.Vector3(
    r * cosLat * Math.cos(lon),
    r * Math.sin(lat),
    -r * cosLat * Math.sin(lon),
  );
}

function ecefToGeodetic(x, y, z) {
  const a = 6378.137;
  const f = 1 / 298.257223563;
  const e2 = 2 * f - f * f;
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));

  for (let i = 0; i < 10; i += 1) {
    const sinLat = Math.sin(lat);
    const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    const next = Math.atan2(z + e2 * n * sinLat, p);
    if (Math.abs(next - lat) < 1e-12) break;
    lat = next;
  }

  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const alt = Math.abs(cosLat) > 1e-10
    ? p / cosLat - n
    : Math.abs(z) / Math.abs(sinLat) - n * (1 - e2);

  return {
    lat: THREE.MathUtils.radToDeg(lat),
    lon: THREE.MathUtils.radToDeg(lon),
    alt,
  };
}

function formatDeg(value, pos, neg) {
  const suffix = value >= 0 ? pos : neg;
  return `${Math.abs(value).toFixed(3)} ${suffix}`;
}

function formatIstTimestamp(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatAge(value) {
  if (!value) return '';
  const date = new Date(value);
  const ageSeconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (!Number.isFinite(ageSeconds)) return '';
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  const ageMinutes = Math.round(ageSeconds / 60);
  if (ageMinutes < 90) return `${ageMinutes}m ago`;
  const ageHours = Math.round(ageMinutes / 60);
  if (ageHours < 48) return `${ageHours}h ago`;
  return `${Math.round(ageHours / 24)}d ago`;
}

function formatMetric(value) {
  if (!Number.isFinite(value)) return '--';
  const abs = Math.abs(value);
  if (abs !== 0 && abs < 0.001) return value.toExponential(2);
  if (abs >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 10) return value.toFixed(2);
  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function fieldLabel(key) {
  return ANALYTICS_FIELDS.find((field) => field.key === key)?.label ?? key;
}

function colorForCorrelation(value) {
  const magnitude = Math.min(1, Math.abs(value));
  if (value >= 0) {
    return `rgba(${Math.round(30 + 30 * magnitude)}, ${Math.round(110 + 130 * magnitude)}, ${Math.round(170 + 60 * magnitude)}, ${0.24 + magnitude * 0.7})`;
  }
  return `rgba(${Math.round(230 + 20 * magnitude)}, ${Math.round(95 + 40 * (1 - magnitude))}, ${Math.round(75 + 20 * (1 - magnitude))}, ${0.24 + magnitude * 0.7})`;
}

function pearsonCorrelation(a, b) {
  const pairs = [];
  for (let i = 0; i < a.length; i += 1) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) pairs.push([a[i], b[i]]);
  }
  if (pairs.length < 2) return 0;

  const meanA = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const meanB = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let numerator = 0;
  let denomA = 0;
  let denomB = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanA;
    const dy = y - meanB;
    numerator += dx * dy;
    denomA += dx * dx;
    denomB += dy * dy;
  }
  const denominator = Math.sqrt(denomA * denomB);
  return denominator > 0 ? numerator / denominator : 0;
}

function metricExtent(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { min: 0, max: 1 };
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (min === max) {
    const pad = Math.abs(min || 1) * 0.05;
    min -= pad;
    max += pad;
  }
  return { min, max };
}

function altitudeBand(alt) {
  if (alt < 2000) return 'leo';
  if (alt < 35786 - 1500) return 'meo';
  if (alt < 35786 + 1500) return 'geo';
  return 'heo';
}

function normalizeLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function latLonToMapXY(lat, lon, width, height) {
  return {
    x: ((normalizeLon(lon) + 180) / 360) * width,
    y: ((90 - lat) / 180) * height,
  };
}

function splitDateline(points, width, height) {
  const segments = [];
  let segment = [];

  for (const point of points) {
    const xy = latLonToMapXY(point.lat, point.lon, width, height);
    if (segment.length && Math.abs(xy.x - segment[segment.length - 1].x) > width * 0.5) {
      segments.push(segment);
      segment = [];
    }
    segment.push(xy);
  }

  if (segment.length) segments.push(segment);
  return segments;
}

function eciPointToEcef(point, gmst) {
  const cosG = Math.cos(gmst);
  const sinG = Math.sin(gmst);
  return new THREE.Vector3(
    cosG * point.x + sinG * point.y,
    -sinG * point.x + cosG * point.y,
    point.z,
  );
}

function sampleOrbitFromState(x, y, z, vx, vy, vz) {
  const r = new THREE.Vector3(x, y, z);
  const v = new THREE.Vector3(vx, vy, vz);
  const h = new THREE.Vector3().crossVectors(r, v);

  if (r.lengthSq() === 0 || h.lengthSq() === 0) return [];

  const rMag = r.length();
  const hSq = h.lengthSq();
  const eccentricityVector = new THREE.Vector3()
    .crossVectors(v, h)
    .multiplyScalar(1 / EARTH_MU_KM3_S2)
    .sub(r.clone().multiplyScalar(1 / rMag));
  const eccentricity = eccentricityVector.length();
  const semiLatusRectum = hSq / EARTH_MU_KM3_S2;
  const basisX = eccentricity > 1e-4 ? eccentricityVector.normalize() : r.clone().normalize();
  const basisY = new THREE.Vector3().crossVectors(h, basisX).normalize();
  const points = [];

  for (let i = 0; i <= ORBIT_SAMPLE_COUNT; i += 1) {
    const theta = ((i / ORBIT_SAMPLE_COUNT) * Math.PI * 2) - Math.PI;
    const denominator = 1 + eccentricity * Math.cos(theta);
    if (Math.abs(denominator) < 1e-8) continue;
    const radius = semiLatusRectum / denominator;
    if (!Number.isFinite(radius) || radius <= 0) continue;
    const point = basisX.clone()
      .multiplyScalar(radius * Math.cos(theta))
      .add(basisY.clone().multiplyScalar(Math.sin(theta) * radius));
    points.push(point);
  }

  return points;
}

export class SatelliteTracker {
  constructor(earthGroup, infoEl, options = {}) {
    this.earthGroup = earthGroup;
    this.infoEl = infoEl;
    this.camera = options.camera;
    this.renderer = options.renderer;
    this.container = options.container ?? document.body;
    this.mapCanvas = options.mapCanvas ?? document.getElementById('map-view');
    this.tooltipEl = options.tooltipEl ?? document.getElementById('sat-tooltip');
    this.controlsEl = options.controlsEl ?? document.getElementById('sat-controls');
    this.resultsEl = options.resultsEl ?? document.getElementById('search-results');
    this.analyticsPanel = options.analyticsPanel ?? document.getElementById('analytics-panel');
    this.analyticsCanvas = options.analyticsCanvas ?? document.getElementById('analytics-chart-canvas');
    this.analyticsTable = options.analyticsTable ?? document.getElementById('analytics-table');
    this.analyticsCountEl = options.analyticsCountEl ?? document.getElementById('analytics-count');
    this.analyticsSideLink = options.analyticsSideLink ?? document.getElementById('analytics-side-link');

    this._fetching = false;
    this._snapshot = null;
    this.viewMode = '3d';
    this._showOrbitals = false;
    this._filters = { ...DEFAULT_FILTERS };
    this._analytics = { ...DEFAULT_ANALYTICS };
    this._visibleIndices = [];
    this._issIndex = -1;
    this._selectedIndex = -1;
    this._hoveredIndex = -1;
    this._lastGroundMapDrawMs = 0;
    this._lastMapDrawMs = 0;
    this._lastCelestrakRefreshAttemptMs = 0;
    this._lastOrbitBuildKey = '';
    this._pointer = new THREE.Vector2();
    this._raycaster = new THREE.Raycaster();
    this._raycaster.params.Points.threshold = 0.025;
    this._mapImage = new Image();
    this._mapImage.addEventListener('load', () => {
      this._drawGroundMap();
      this._drawMapView(true);
    });
    this._mapImage.src = EARTH_MAP_SRC;

    this._buildPoints();
    this._buildSelectedMarker();
    this._buildOrbitals();
    this._populateAnalyticsControls();
    this._bindUi();
    this._setViewMode(this.viewMode);
    this._syncPageRoute();
    this._startPolling();
  }

  _buildPoints() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));

    const mat = new THREE.PointsMaterial({
      size: 0.014,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      vertexColors: true,
    });

    this.points = new THREE.Points(geo, mat);
    this.earthGroup.add(this.points);
  }

  _buildSelectedMarker() {
    const geo = new THREE.SphereGeometry(0.02, 16, 16);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.selectedMarker = new THREE.Mesh(geo, mat);
    this.selectedMarker.visible = false;

    const glowGeo = new THREE.SphereGeometry(0.036, 16, 16);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x00ffaa,
      transparent: true,
      opacity: 0.28,
    });
    this.selectedGlow = new THREE.Mesh(glowGeo, glowMat);
    this.selectedGlow.visible = false;

    this.earthGroup.add(this.selectedMarker, this.selectedGlow);
  }

  _buildOrbitals() {
    this.orbitGroup = new THREE.Group();
    this.orbitGroup.visible = false;
    this.earthGroup.add(this.orbitGroup);
  }

  _populateAnalyticsControls() {
    const xSelect = document.getElementById('analytics-x');
    const ySelect = document.getElementById('analytics-y');
    if (!(xSelect instanceof HTMLSelectElement) || !(ySelect instanceof HTMLSelectElement)) return;

    const options = ANALYTICS_FIELDS.map((field) => (
      `<option value="${field.key}">${field.label}</option>`
    )).join('');
    xSelect.innerHTML = options;
    ySelect.innerHTML = options;
    xSelect.value = this._analytics.x;
    ySelect.value = this._analytics.y;
  }

  _bindUi() {
    this.controlsEl?.addEventListener('input', (event) => {
      const el = event.target;
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement)) return;

      if (el.id === 'sat-search') this._filters.search = el.value.trim().toLowerCase();
      if (el.id === 'country-filter') this._filters.country = el.value;
      if (el.id === 'inclination-min') this._filters.inclination[0] = Number(el.value);
      if (el.id === 'inclination-max') this._filters.inclination[1] = Number(el.value);
      if (el.id === 'eccentricity-max') this._filters.eccentricityMax = Number(el.value);
      if (el.id === 'mean-motion-min') this._filters.meanMotion[0] = Number(el.value);
      if (el.id === 'mean-motion-max') this._filters.meanMotion[1] = Number(el.value);
      if (el.id === 'raan-min') this._filters.raan[0] = Number(el.value);
      if (el.id === 'raan-max') this._filters.raan[1] = Number(el.value);
      if (el.id === 'arg-perigee-min') this._filters.argPerigee[0] = Number(el.value);
      if (el.id === 'arg-perigee-max') this._filters.argPerigee[1] = Number(el.value);
      if (el.id === 'mean-anomaly-min') this._filters.meanAnomaly[0] = Number(el.value);
      if (el.id === 'mean-anomaly-max') this._filters.meanAnomaly[1] = Number(el.value);
      if (el.id === 'bstar-max') this._filters.bstarMax = Number(el.value);
      if (el.id === 'tle-age-max') this._filters.tleAgeMaxDays = Number(el.value);

      this._syncRangeLabels();
      this._rebuildVisibleGeometry();
    });

    this.controlsEl?.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const viewButton = target?.closest('[data-view-mode]');
      if (viewButton) {
        this._setViewMode(viewButton.dataset.viewMode);
        return;
      }

      const chip = target?.closest('[data-altitude-band]');
      if (chip) {
        this._filters.altitudeBand = chip.dataset.altitudeBand;
        this.controlsEl.querySelectorAll('[data-altitude-band]').forEach((node) => {
          node.classList.toggle('active', node === chip);
        });
        this._rebuildVisibleGeometry();
        return;
      }

      const result = target?.closest('[data-sat-index]');
      if (result) {
        this._selectSatellite(Number(result.dataset.satIndex), true);
      }
    });

    const orbitToggle = this.controlsEl?.querySelector('#orbit-toggle');
    orbitToggle?.addEventListener('change', (event) => {
      this._showOrbitals = event.target.checked;
      this._rebuildOrbitals(true);
      this._drawMapView(true);
    });

    const panelToggle = document.getElementById('panel-toggle');
    panelToggle?.addEventListener('click', () => {
      const hidden = document.body.classList.toggle('panels-hidden');
      panelToggle.setAttribute('aria-pressed', String(hidden));
      panelToggle.setAttribute('aria-label', hidden ? 'Show side panels' : 'Hide side panels');
      panelToggle.textContent = hidden ? 'Show panels' : 'Hide panels';
    });

    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-close-info-panel]')) {
        document.body.classList.add('info-panel-closed');
        return;
      }
      if (target?.closest('#info-panel-open')) {
        document.body.classList.remove('info-panel-closed');
      }
    });

    this.analyticsSideLink?.addEventListener('click', () => {
      window.location.hash = 'analytics';
    });

    this.analyticsPanel?.addEventListener('input', (event) => {
      const el = event.target;
      if (!(el instanceof HTMLSelectElement)) return;
      if (el.id === 'analytics-chart') this._analytics.chart = el.value;
      if (el.id === 'analytics-x') this._analytics.x = el.value;
      if (el.id === 'analytics-y') this._analytics.y = el.value;
      this._updateAnalyticsPanel();
    });

    this.analyticsPanel?.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const toggle = target?.closest('#analytics-toggle');
      if (toggle) {
        window.history.pushState(null, '', `${window.location.pathname}${window.location.search}`);
        this._syncPageRoute();
        return;
      }

      const row = target?.closest('[data-analytics-index]');
      if (row) {
        this._selectSatellite(Number(row.dataset.analyticsIndex), true);
      }
    });

    this.renderer?.domElement.addEventListener('pointermove', (event) => this._onPointerMove(event));
    this.renderer?.domElement.addEventListener('pointerleave', () => this._hideTooltip());
    this.mapCanvas?.addEventListener('pointermove', (event) => this._onMapPointerMove(event));
    this.mapCanvas?.addEventListener('click', (event) => this._onMapClick(event));
    this.mapCanvas?.addEventListener('pointerleave', () => this._hideTooltip());
    window.addEventListener('hashchange', () => this._syncPageRoute());
  }

  _syncPageRoute() {
    const analyticsPage = window.location.hash === '#analytics';
    document.body.classList.toggle('analytics-page', analyticsPage);
    this.analyticsSideLink?.setAttribute('aria-current', analyticsPage ? 'page' : 'false');
    if (analyticsPage) requestAnimationFrame(() => this._updateAnalyticsPanel());
  }

  _setViewMode(mode) {
    this.viewMode = mode === '2d' ? '2d' : '3d';

    this.controlsEl?.querySelectorAll('[data-view-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.viewMode === this.viewMode);
    });

    if (this.renderer?.domElement) {
      this.renderer.domElement.style.display = this.viewMode === '3d' ? 'block' : 'none';
    }
    if (this.mapCanvas) {
      this.mapCanvas.style.display = this.viewMode === '2d' ? 'block' : 'none';
    }
    if (this.points) this.points.visible = this.viewMode === '3d' && this._visibleIndices.length > 0;
    if (this.orbitGroup) this.orbitGroup.visible = this.viewMode === '3d' && this._showOrbitals;
    if (this.selectedMarker) this.selectedMarker.visible = this.viewMode === '3d' && this._selectedIndex >= 0;
    if (this.selectedGlow) this.selectedGlow.visible = this.viewMode === '3d' && this._selectedIndex >= 0;

    this._drawMapView(true);
  }

  _resizeMapCanvas() {
    if (!this.mapCanvas) return false;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.floor(window.innerWidth * pixelRatio);
    const height = Math.floor(window.innerHeight * pixelRatio);
    if (this.mapCanvas.width === width && this.mapCanvas.height === height) return false;

    this.mapCanvas.width = width;
    this.mapCanvas.height = height;
    return true;
  }

  _activeOrbitIndices() {
    if (!this._snapshot) return [];
    if (this._selectedIndex >= 0) return [this._selectedIndex];
    if (this._visibleIndices.length > 0 && this._visibleIndices.length <= ORBIT_VISIBLE_LIMIT) {
      return this._visibleIndices;
    }
    return this._issIndex >= 0 ? [this._issIndex] : [];
  }

  _orbitPointsForIndex(index) {
    if (!this._snapshot || index < 0) return [];
    const i3 = index * 3;
    const state = this._snapshot.eciPos && this._snapshot.eciVel
      ? { pos: this._snapshot.eciPos, vel: this._snapshot.eciVel, inertial: true }
      : { pos: this._snapshot.pos, vel: this._snapshot.vel, inertial: false };
    const points = sampleOrbitFromState(
      state.pos[i3],
      state.pos[i3 + 1],
      state.pos[i3 + 2],
      state.vel[i3],
      state.vel[i3 + 1],
      state.vel[i3 + 2],
    );

    if (!state.inertial) return points;
    return points.map((point) => eciPointToEcef(point, this._snapshot.gmstRad));
  }

  _rebuildOrbitals(force = false) {
    if (!this.orbitGroup || !this._snapshot) return;
    const indices = this._showOrbitals ? this._activeOrbitIndices() : [];
    const key = `${this._showOrbitals}:${indices.join(',')}`;
    if (!force && key === this._lastOrbitBuildKey) return;
    this._lastOrbitBuildKey = key;

    this.orbitGroup.clear();
    this.orbitGroup.visible = this.viewMode === '3d' && this._showOrbitals;
    if (!this._showOrbitals) return;

    for (const index of indices) {
      const vertices = this._orbitPointsForIndex(index).map((point) => ecefKmToThree(point.x, point.y, point.z));
      if (vertices.length < 2) continue;

      const geo = new THREE.BufferGeometry().setFromPoints(vertices);
      const isSelected = index === this._selectedIndex || this._snapshot.ids[index] === ISS_NORAD;
      const mat = new THREE.LineBasicMaterial({
        color: isSelected ? 0x00ffaa : 0x35c8ff,
        transparent: true,
        opacity: isSelected ? 0.82 : 0.38,
      });
      this.orbitGroup.add(new THREE.Line(geo, mat));
    }
  }

  _drawMapView(force = false) {
    if (!this.mapCanvas || this.viewMode !== '2d' || !this._snapshot) return;
    const resized = this._resizeMapCanvas();
    const now = Date.now();
    if (!force && !resized && now - this._lastMapDrawMs < 250) return;
    this._lastMapDrawMs = now;

    const ctx = this.mapCanvas.getContext('2d');
    const { width, height } = this.mapCanvas;
    ctx.clearRect(0, 0, width, height);

    if (this._mapImage.complete && this._mapImage.naturalWidth > 0) {
      ctx.drawImage(this._mapImage, 0, 0, width, height);
    } else {
      ctx.fillStyle = '#031019';
      ctx.fillRect(0, 0, width, height);
    }

    this._drawMapGrid(ctx, width, height);
    if (this._showOrbitals) this._drawMapOrbitals(ctx, width, height);
    this._drawMapSatellites(ctx, width, height);
  }

  _drawMapGrid(ctx, width, height) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = `${Math.max(10, Math.round(width / 150))}px Space Mono, monospace`;
    ctx.fillStyle = 'rgba(232,244,248,0.86)';
    ctx.textBaseline = 'middle';

    for (let lon = -180; lon <= 180; lon += 30) {
      const { x } = latLonToMapXY(0, lon, width, height);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.strokeStyle = lon === 0 ? 'rgba(0,255,170,0.78)' : 'rgba(255,255,255,0.18)';
      ctx.stroke();
      if (lon > -180 && lon < 180 && lon % 60 === 0) {
        ctx.textAlign = 'center';
        ctx.fillText(lon === 0 ? '0' : `${Math.abs(lon)}${lon > 0 ? 'E' : 'W'}`, x, height / 2 + 18);
      }
    }

    for (let lat = -60; lat <= 60; lat += 30) {
      const { y } = latLonToMapXY(lat, 0, width, height);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.strokeStyle = lat === 0 ? 'rgba(0,200,224,0.78)' : 'rgba(255,255,255,0.18)';
      ctx.stroke();
      if (lat !== 0) {
        ctx.textAlign = 'left';
        ctx.fillText(`${Math.abs(lat)}${lat > 0 ? 'N' : 'S'}`, 12, y);
      }
    }

    ctx.restore();
  }

  _drawMapOrbitals(ctx, width, height) {
    ctx.save();
    ctx.lineWidth = Math.max(1.2, width / 900);
    for (const index of this._activeOrbitIndices()) {
      const geoPoints = this._orbitPointsForIndex(index).map((point) => {
        const geo = ecefToGeodetic(point.x, point.y, point.z);
        return { lat: geo.lat, lon: geo.lon };
      });
      const isSelected = index === this._selectedIndex || this._snapshot.ids[index] === ISS_NORAD;
      ctx.strokeStyle = isSelected ? 'rgba(0,255,170,0.86)' : 'rgba(53,200,255,0.42)';

      for (const segment of splitDateline(geoPoints, width, height)) {
        if (segment.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(segment[0].x, segment[0].y);
        for (let i = 1; i < segment.length; i += 1) ctx.lineTo(segment[i].x, segment[i].y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _drawMapSatellites(ctx, width, height) {
    ctx.save();
    const pointRadius = Math.max(1.4, Math.min(3, width / 520));

    for (const index of this._visibleIndices) {
      const geo = this._snapshot.geodetic[index];
      const { x, y } = latLonToMapXY(geo.lat, geo.lon, width, height);
      const isIss = this._snapshot.ids[index] === ISS_NORAD;
      ctx.fillStyle = isIss ? '#ffffff' : 'rgba(120,220,255,0.78)';
      ctx.beginPath();
      ctx.arc(x, y, isIss ? pointRadius + 1.2 : pointRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    const selectedIndex = this._selectedIndex >= 0 ? this._selectedIndex : this._issIndex;
    if (selectedIndex >= 0) {
      const geo = this._snapshot.geodetic[selectedIndex];
      const { x, y } = latLonToMapXY(geo.lat, geo.lon, width, height);
      ctx.lineWidth = Math.max(2, width / 640);
      ctx.strokeStyle = '#00ffaa';
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, pointRadius + 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
  }

  _mapEventToGeo(event) {
    if (!this.mapCanvas) return null;
    const rect = this.mapCanvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return {
      lat: 90 - y * 180,
      lon: normalizeLon(x * 360 - 180),
      clientX: event.clientX,
      clientY: event.clientY,
    };
  }

  _nearestVisibleSatellite(lat, lon) {
    if (!this._snapshot || !this._visibleIndices.length) return -1;
    let bestIndex = -1;
    let bestDist = Infinity;

    for (const index of this._visibleIndices) {
      const geo = this._snapshot.geodetic[index];
      const dLon = Math.abs(normalizeLon(geo.lon - lon));
      const dLat = Math.abs(geo.lat - lat);
      const dist = dLat * dLat + dLon * dLon;
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = index;
      }
    }

    return bestDist < 100 ? bestIndex : -1;
  }

  _onMapPointerMove(event) {
    if (this.viewMode !== '2d') return;
    const geo = this._mapEventToGeo(event);
    if (!geo) return;
    const index = this._nearestVisibleSatellite(geo.lat, geo.lon);
    if (index < 0) {
      this._hideTooltip();
      return;
    }
    this._hoveredIndex = index;
    this._showTooltip(index, geo.clientX, geo.clientY);
  }

  _onMapClick(event) {
    if (this.viewMode !== '2d') return;
    const geo = this._mapEventToGeo(event);
    if (!geo) return;
    const index = this._nearestVisibleSatellite(geo.lat, geo.lon);
    if (index >= 0) this._selectSatellite(index, true);
  }

  async _fetchSatellites() {
    let res = await fetch('/api/satellites');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let data = await res.json();
    if (data.error) throw new Error(data.error);

    const shouldRefreshFromCelestrak = (data.catalog ?? 0) < 100
      || data.plot_data_current === false
      || data.tle_source_status !== 'celestrak';

    const refreshAttemptDue = Date.now() - this._lastCelestrakRefreshAttemptMs
      >= CELESTRAK_BROWSER_REFRESH_MIN_MS;

    if (shouldRefreshFromCelestrak && refreshAttemptDue) {
      this._lastCelestrakRefreshAttemptMs = Date.now();
      const refresh = this._fetchCelestrakFromBrowser();
      if ((data.catalog ?? 0) < 100) {
        const refreshed = await refresh;
        if (refreshed) return refreshed;
      } else {
        refresh.then((refreshed) => {
          if (!refreshed || this._fetching) return;
          this._applySnapshot(refreshed);
          this._updateInfoPanel(refreshed);
        });
      }
    }

    return data;
  }

  async _fetchCelestrakFromBrowser() {
    for (const url of CELESTRAK_2LE_URLS) {
      try {
        const tleRes = await fetch(url);
        if (!tleRes.ok) continue;
        const tleText = await tleRes.text();
        const res = await fetch('/api/satellites', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: tleText,
        });
        if (res.ok) {
          const data = await res.json();
          if (!data.error) return data;
        }
      } catch (e) {
        console.warn('[Satellites] CelesTrak browser refresh:', e.message);
      }
    }
    return null;
  }

  _startPolling() {
    const poll = async () => {
      if (this._fetching) return;
      this._fetching = true;
      try {
        const data = await this._fetchSatellites();
        this._applySnapshot(data);
        this._updateInfoPanel(data);
      } catch (e) {
        console.warn('[Satellites] Fetch error:', e.message);
        if (this.infoEl && !this._snapshot) {
          this.infoEl.innerHTML = '<span style="color:#ff4444">Cannot reach satellite server.<br>Run python/server.py, then refresh.</span>';
        }
      } finally {
        this._fetching = false;
      }
    };

    poll();
    setInterval(poll, POLL_INTERVAL_MS);
  }

  _clearPlots() {
    this._snapshot = null;
    this._visibleIndices = [];
    this._issIndex = -1;
    this._selectedIndex = -1;
    this._hoveredIndex = -1;
    this.points.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    this.points.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
    this.points.geometry.computeBoundingSphere();
    this.points.visible = false;
    this.orbitGroup?.clear();
    if (this.selectedMarker) this.selectedMarker.visible = false;
    if (this.selectedGlow) this.selectedGlow.visible = false;
    this.resultsEl && (this.resultsEl.innerHTML = '<div class="empty-results">Waiting for current CelesTrak data</div>');
    this._updateCounts();
    this._updateAnalyticsPanel();
    this._drawUnavailableMap();
    this._drawGroundMap();
  }

  _drawUnavailableMap() {
    if (!this.mapCanvas || this.viewMode !== '2d') return;
    this._resizeMapCanvas();
    const ctx = this.mapCanvas.getContext('2d');
    const { width, height } = this.mapCanvas;
    ctx.clearRect(0, 0, width, height);
    if (this._mapImage.complete && this._mapImage.naturalWidth > 0) {
      ctx.drawImage(this._mapImage, 0, 0, width, height);
    } else {
      ctx.fillStyle = '#031019';
      ctx.fillRect(0, 0, width, height);
    }
    this._drawMapGrid(ctx, width, height);
    ctx.save();
    ctx.fillStyle = 'rgba(5, 10, 20, 0.78)';
    ctx.fillRect(0, height / 2 - 30, width, 60);
    ctx.fillStyle = '#ffb300';
    ctx.font = `${Math.max(13, Math.round(width / 120))}px Space Mono, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Waiting for current CelesTrak data', width / 2, height / 2);
    ctx.restore();
  }

  _applySnapshot(data) {
    const count = data.ids.length;
    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    const eciPos = data.eci ? new Float32Array(count * 3) : null;
    const eciVel = data.eci ? new Float32Array(count * 3) : null;

    for (let i = 0; i < count; i += 1) {
      const j = i * 6;
      pos[i * 3] = data.ecef[j];
      pos[i * 3 + 1] = data.ecef[j + 1];
      pos[i * 3 + 2] = data.ecef[j + 2];
      vel[i * 3] = data.ecef[j + 3];
      vel[i * 3 + 1] = data.ecef[j + 4];
      vel[i * 3 + 2] = data.ecef[j + 5];

      if (data.eci) {
        eciPos[i * 3] = data.eci[j];
        eciPos[i * 3 + 1] = data.eci[j + 1];
        eciPos[i * 3 + 2] = data.eci[j + 2];
        eciVel[i * 3] = data.eci[j + 3];
        eciVel[i * 3 + 1] = data.eci[j + 4];
        eciVel[i * 3 + 2] = data.eci[j + 5];
      }
    }

    this._issIndex = data.ids.indexOf(ISS_NORAD);
    this._snapshot = {
      ...data,
      count,
      pos,
      vel,
      eciPos,
      eciVel,
      display: new Float32Array(count * 3),
      geodetic: Array.from({ length: count }, () => ({ lat: 0, lon: 0, alt: 0 })),
      gmstRad: Number(data.gmst_rad ?? 0),
      timeMs: Date.parse(data.timestamp_utc),
    };

    this._populateCountryFilter();
    this._fillCurrentState();
    this._rebuildVisibleGeometry();
  }

  _populateCountryFilter() {
    const select = document.getElementById('country-filter');
    if (!select || !this._snapshot) return;

    const selected = select.value;
    const countries = [...new Set(this._snapshot.countries.filter(Boolean))].sort();
    select.innerHTML = '<option value="all">All countries</option>';
    for (const country of countries) {
      const option = document.createElement('option');
      option.value = country;
      option.textContent = country;
      select.appendChild(option);
    }
    select.value = countries.includes(selected) ? selected : 'all';
    this._filters.country = select.value;
  }

  _fillCurrentState() {
    if (!this._snapshot) return;
    const { count, pos, vel, display, geodetic } = this._snapshot;

    for (let i = 0; i < count; i += 1) {
      const i3 = i * 3;
      const x = pos[i3];
      const y = pos[i3 + 1];
      const z = pos[i3 + 2];
      const point = ecefKmToThree(x, y, z);
      display[i3] = point.x;
      display[i3 + 1] = point.y;
      display[i3 + 2] = point.z;
      geodetic[i] = ecefToGeodetic(x, y, z);
    }
  }

  _matchesFilters(i) {
    const s = this._snapshot;
    const geo = s.geodetic[i];
    const query = this._filters.search;
    const haystack = `${s.names[i]} ${s.ids[i]} ${s.object_ids[i]}`.toLowerCase();
    const epochMs = Date.parse(s.epoch_utc?.[i] ?? '');
    const ageDays = Number.isFinite(epochMs)
      ? (Date.now() - epochMs) / (24 * 60 * 60 * 1000)
      : Infinity;

    return (!query || haystack.includes(query))
      && (this._filters.country === 'all' || s.countries[i] === this._filters.country)
      && (this._filters.altitudeBand === 'all' || altitudeBand(geo.alt) === this._filters.altitudeBand)
      && s.inclinations[i] >= this._filters.inclination[0]
      && s.inclinations[i] <= this._filters.inclination[1]
      && s.eccentricities[i] <= this._filters.eccentricityMax
      && s.mean_motion[i] >= this._filters.meanMotion[0]
      && s.mean_motion[i] <= this._filters.meanMotion[1]
      && s.raan[i] >= this._filters.raan[0]
      && s.raan[i] <= this._filters.raan[1]
      && s.arg_perigee[i] >= this._filters.argPerigee[0]
      && s.arg_perigee[i] <= this._filters.argPerigee[1]
      && s.mean_anomaly[i] >= this._filters.meanAnomaly[0]
      && s.mean_anomaly[i] <= this._filters.meanAnomaly[1]
      && Math.abs(s.bstar[i]) <= this._filters.bstarMax
      && ageDays <= this._filters.tleAgeMaxDays;
  }

  _rebuildVisibleGeometry() {
    if (!this._snapshot) return;
    this._fillCurrentState();
    const visible = [];
    const positions = [];
    const colors = [];

    for (let i = 0; i < this._snapshot.count; i += 1) {
      if (!this._matchesFilters(i)) continue;
      const i3 = i * 3;
      visible.push(i);
      positions.push(
        this._snapshot.display[i3],
        this._snapshot.display[i3 + 1],
        this._snapshot.display[i3 + 2],
      );
      const isIss = this._snapshot.ids[i] === ISS_NORAD;
      colors.push(isIss ? 1 : 0.34, isIss ? 1 : 0.78, isIss ? 1 : 1);
    }

    this._visibleIndices = visible;
    this.points.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    this.points.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.computeBoundingSphere();
    this.points.visible = this.viewMode === '3d' && visible.length > 0;
    this._renderSearchResults();
    this._updateCounts();
    this._rebuildOrbitals(true);
    this._drawMapView(true);
    this._updateAnalyticsPanel();
  }

  _renderSearchResults() {
    if (!this.resultsEl || !this._snapshot) return;
    const rows = this._visibleIndices.slice(0, 8).map((satIndex) => {
      const geo = this._snapshot.geodetic[satIndex];
      return `
        <button type="button" class="search-result" data-sat-index="${satIndex}">
          <span>${this._snapshot.names[satIndex]}</span>
          <small>${this._snapshot.ids[satIndex]} · Lat ${formatDeg(geo.lat, 'N', 'S')} · Long ${formatDeg(geo.lon, 'E', 'W')}</small>
        </button>
      `;
    }).join('');
    this.resultsEl.innerHTML = rows || '<div class="empty-results">No matching satellites</div>';
  }

  _metricValue(index, key) {
    if (!this._snapshot) return NaN;
    const s = this._snapshot;
    const geo = s.geodetic[index];
    switch (key) {
      case 'altitude': return geo?.alt;
      case 'latitude': return geo?.lat;
      case 'longitude': return geo?.lon;
      case 'inclination': return s.inclinations[index];
      case 'raan': return s.raan[index];
      case 'eccentricity': return s.eccentricities[index];
      case 'argPerigee': return s.arg_perigee[index];
      case 'meanAnomaly': return s.mean_anomaly[index];
      case 'meanMotion': return s.mean_motion[index];
      case 'bstar': return s.bstar[index];
      default: return NaN;
    }
  }

  _analyticsRows() {
    if (!this._snapshot) return [];
    return this._visibleIndices.map((index) => ({
      index,
      name: this._snapshot.names[index],
      country: this._snapshot.countries[index],
      norad: this._snapshot.ids[index],
      x: this._metricValue(index, this._analytics.x),
      y: this._metricValue(index, this._analytics.y),
    })).filter((row) => Number.isFinite(row.x) && Number.isFinite(row.y));
  }

  _prepareAnalyticsCanvas() {
    if (!(this.analyticsCanvas instanceof HTMLCanvasElement)) return null;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.analyticsCanvas.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width * pixelRatio));
    const height = Math.max(220, Math.floor(rect.height * pixelRatio));
    if (this.analyticsCanvas.width !== width || this.analyticsCanvas.height !== height) {
      this.analyticsCanvas.width = width;
      this.analyticsCanvas.height = height;
    }
    const ctx = this.analyticsCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#031019';
    ctx.fillRect(0, 0, width, height);
    return { ctx, width, height };
  }

  _drawAnalyticsAxes(ctx, width, height, xLabel, yLabel = '') {
    const pad = { left: 56, right: 18, top: 20, bottom: 44 };
    ctx.save();
    ctx.strokeStyle = 'rgba(176,196,206,0.36)';
    ctx.fillStyle = 'rgba(232,244,248,0.82)';
    ctx.lineWidth = 1;
    ctx.font = '11px Space Mono, monospace';
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, height - pad.bottom);
    ctx.lineTo(width - pad.right, height - pad.bottom);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(xLabel, (pad.left + width - pad.right) / 2, height - 12);
    if (yLabel) {
      ctx.save();
      ctx.translate(14, (pad.top + height - pad.bottom) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(yLabel, 0, 0);
      ctx.restore();
    }
    ctx.restore();
    return pad;
  }

  _drawHistogram(rows) {
    const prepared = this._prepareAnalyticsCanvas();
    if (!prepared) return;
    const { ctx, width, height } = prepared;
    const values = rows.map((row) => row.x).filter(Number.isFinite);
    const pad = this._drawAnalyticsAxes(ctx, width, height, fieldLabel(this._analytics.x), 'Count');
    if (!values.length) return this._drawAnalyticsEmpty(ctx, width, height);

    const { min, max } = metricExtent(values);
    const bins = 18;
    const counts = Array.from({ length: bins }, () => 0);
    for (const value of values) {
      const t = Math.min(0.999999, Math.max(0, (value - min) / (max - min)));
      counts[Math.floor(t * bins)] += 1;
    }

    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;
    const maxCount = Math.max(...counts, 1);
    counts.forEach((count, i) => {
      const barW = chartW / bins;
      const barH = (count / maxCount) * chartH;
      const x = pad.left + i * barW + 2;
      const y = height - pad.bottom - barH;
      ctx.fillStyle = 'rgba(0,200,224,0.78)';
      ctx.fillRect(x, y, Math.max(2, barW - 4), barH);
    });
    this._drawExtentLabels(ctx, width, height, pad, min, max);
  }

  _drawScatter(rows) {
    const prepared = this._prepareAnalyticsCanvas();
    if (!prepared) return;
    const { ctx, width, height } = prepared;
    const pad = this._drawAnalyticsAxes(ctx, width, height, fieldLabel(this._analytics.x), fieldLabel(this._analytics.y));
    if (!rows.length) return this._drawAnalyticsEmpty(ctx, width, height);

    const xExtent = metricExtent(rows.map((row) => row.x));
    const yExtent = metricExtent(rows.map((row) => row.y));
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;
    ctx.fillStyle = 'rgba(0,255,170,0.62)';
    for (const row of rows) {
      const tx = (row.x - xExtent.min) / (xExtent.max - xExtent.min);
      const ty = (row.y - yExtent.min) / (yExtent.max - yExtent.min);
      const x = pad.left + tx * chartW;
      const y = height - pad.bottom - ty * chartH;
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    this._drawExtentLabels(ctx, width, height, pad, xExtent.min, xExtent.max, yExtent.min, yExtent.max);
  }

  _drawHeatmap(rows) {
    const prepared = this._prepareAnalyticsCanvas();
    if (!prepared) return;
    const { ctx, width, height } = prepared;
    const pad = this._drawAnalyticsAxes(ctx, width, height, fieldLabel(this._analytics.x), fieldLabel(this._analytics.y));
    if (!rows.length) return this._drawAnalyticsEmpty(ctx, width, height);

    const xExtent = metricExtent(rows.map((row) => row.x));
    const yExtent = metricExtent(rows.map((row) => row.y));
    const bins = ANALYTICS_HEATMAP_BINS;
    const grid = Array.from({ length: bins }, () => Array.from({ length: bins }, () => 0));
    for (const row of rows) {
      const tx = Math.min(0.999999, Math.max(0, (row.x - xExtent.min) / (xExtent.max - xExtent.min)));
      const ty = Math.min(0.999999, Math.max(0, (row.y - yExtent.min) / (yExtent.max - yExtent.min)));
      grid[Math.floor(ty * bins)][Math.floor(tx * bins)] += 1;
    }
    const maxCount = Math.max(...grid.flat(), 1);
    const cellW = (width - pad.left - pad.right) / bins;
    const cellH = (height - pad.top - pad.bottom) / bins;
    for (let y = 0; y < bins; y += 1) {
      for (let x = 0; x < bins; x += 1) {
        const alpha = grid[y][x] / maxCount;
        ctx.fillStyle = `rgba(0, ${Math.round(120 + alpha * 135)}, ${Math.round(160 + alpha * 80)}, ${0.16 + alpha * 0.82})`;
        ctx.fillRect(pad.left + x * cellW, height - pad.bottom - (y + 1) * cellH, cellW - 1, cellH - 1);
      }
    }
    this._drawExtentLabels(ctx, width, height, pad, xExtent.min, xExtent.max, yExtent.min, yExtent.max);
  }

  _drawCorrelationMap() {
    const prepared = this._prepareAnalyticsCanvas();
    if (!prepared || !this._snapshot) return;
    const { ctx, width, height } = prepared;
    const fields = ANALYTICS_FIELDS;
    const values = Object.fromEntries(fields.map((field) => [
      field.key,
      this._visibleIndices.map((index) => this._metricValue(index, field.key)),
    ]));
    const size = Math.min(width - 170, height - 52) / fields.length;
    const left = 118;
    const top = 18;

    ctx.save();
    ctx.font = '10px Space Mono, monospace';
    ctx.textBaseline = 'middle';
    fields.forEach((field, row) => {
      ctx.fillStyle = 'rgba(232,244,248,0.82)';
      ctx.textAlign = 'right';
      ctx.fillText(field.label, left - 8, top + row * size + size / 2);
      ctx.save();
      ctx.translate(left + row * size + size / 2, top + fields.length * size + 8);
      ctx.rotate(Math.PI / 4);
      ctx.textAlign = 'left';
      ctx.fillText(field.label, 0, 0);
      ctx.restore();

      fields.forEach((other, col) => {
        const corr = pearsonCorrelation(values[field.key], values[other.key]);
        ctx.fillStyle = colorForCorrelation(corr);
        ctx.fillRect(left + col * size, top + row * size, size - 1, size - 1);
        if (size > 28) {
          ctx.fillStyle = 'rgba(255,255,255,0.88)';
          ctx.textAlign = 'center';
          ctx.fillText(corr.toFixed(2), left + col * size + size / 2, top + row * size + size / 2);
        }
      });
    });
    ctx.restore();
  }

  _drawExtentLabels(ctx, width, height, pad, xMin, xMax, yMin = null, yMax = null) {
    ctx.save();
    ctx.fillStyle = 'rgba(176,196,206,0.84)';
    ctx.font = '10px Space Mono, monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(formatMetric(xMin), pad.left, height - pad.bottom + 8);
    ctx.textAlign = 'right';
    ctx.fillText(formatMetric(xMax), width - pad.right, height - pad.bottom + 8);
    if (Number.isFinite(yMin) && Number.isFinite(yMax)) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(formatMetric(yMax), pad.left - 8, pad.top + 4);
      ctx.textBaseline = 'top';
      ctx.fillText(formatMetric(yMin), pad.left - 8, height - pad.bottom - 12);
    }
    ctx.restore();
  }

  _drawAnalyticsEmpty(ctx, width, height) {
    ctx.save();
    ctx.fillStyle = 'rgba(232,244,248,0.72)';
    ctx.font = '13px Space Mono, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No visible satellite data for this chart', width / 2, height / 2);
    ctx.restore();
  }

  _renderAnalyticsTable(rows) {
    if (!(this.analyticsTable instanceof HTMLTableElement)) return;
    const xHead = document.getElementById('analytics-x-head');
    const yHead = document.getElementById('analytics-y-head');
    if (xHead) xHead.textContent = fieldLabel(this._analytics.x);
    if (yHead) yHead.textContent = fieldLabel(this._analytics.y);

    const tbody = this.analyticsTable.querySelector('tbody');
    if (!tbody) return;
    const shown = rows.slice(0, ANALYTICS_TABLE_LIMIT);
    tbody.innerHTML = shown.length
      ? shown.map((row) => `
        <tr data-analytics-index="${row.index}">
          <td title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</td>
          <td>${escapeHtml(row.country || 'Unknown')}</td>
          <td>${escapeHtml(row.norad)}</td>
          <td>${formatMetric(row.x)}</td>
          <td>${formatMetric(row.y)}</td>
        </tr>
      `).join('')
      : '<tr><td colspan="5">No visible satellite data</td></tr>';
  }

  _updateAnalyticsPanel() {
    const rows = this._analyticsRows();
    if (this.analyticsCountEl) {
      const suffix = rows.length > ANALYTICS_TABLE_LIMIT ? `, showing ${ANALYTICS_TABLE_LIMIT}` : '';
      this.analyticsCountEl.textContent = `${rows.length.toLocaleString()} plotted satellites${suffix}`;
    }

    const chartSelect = document.getElementById('analytics-chart');
    const xSelect = document.getElementById('analytics-x');
    const ySelect = document.getElementById('analytics-y');
    if (chartSelect instanceof HTMLSelectElement) chartSelect.value = this._analytics.chart;
    if (xSelect instanceof HTMLSelectElement) xSelect.value = this._analytics.x;
    if (ySelect instanceof HTMLSelectElement) {
      ySelect.value = this._analytics.y;
      ySelect.disabled = this._analytics.chart === 'histogram' || this._analytics.chart === 'correlation';
    }

    if (this._analytics.chart === 'histogram') this._drawHistogram(rows);
    if (this._analytics.chart === 'scatter') this._drawScatter(rows);
    if (this._analytics.chart === 'heatmap') this._drawHeatmap(rows);
    if (this._analytics.chart === 'correlation') this._drawCorrelationMap();
    this._renderAnalyticsTable(rows);
  }

  _syncRangeLabels() {
    document.getElementById('inclination-label').textContent = `${this._filters.inclination[0]}° - ${this._filters.inclination[1]}°`;
    document.getElementById('eccentricity-label').textContent = `≤ ${this._filters.eccentricityMax.toFixed(2)}`;
    document.getElementById('mean-motion-label').textContent = `${this._filters.meanMotion[0]} - ${this._filters.meanMotion[1]} rev/day`;
    document.getElementById('raan-label').textContent = `${this._filters.raan[0]}° - ${this._filters.raan[1]}°`;
    document.getElementById('arg-perigee-label').textContent = `${this._filters.argPerigee[0]}° - ${this._filters.argPerigee[1]}°`;
    document.getElementById('mean-anomaly-label').textContent = `${this._filters.meanAnomaly[0]}° - ${this._filters.meanAnomaly[1]}°`;
    document.getElementById('bstar-label').textContent = `≤ ${this._filters.bstarMax.toFixed(4)}`;
    document.getElementById('tle-age-label').textContent = `≤ ${this._filters.tleAgeMaxDays} days`;
  }

  _updateCounts() {
    const visibleCountEl = document.getElementById('visible-count');
    if (visibleCountEl) {
      visibleCountEl.textContent = this._visibleIndices.length.toLocaleString();
    }
  }

  _updateInfoPanel(data) {
    if (!this.infoEl) return;
    const utcDate = new Date(data.timestamp_utc);
    const istStr = utcDate.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
    });
    const isCelestrak = data.tle_source_status === 'celestrak';
    const loadedAt = isCelestrak ? data.celestrak_fetched_at_utc : data.catalog_loaded_at_utc;
    const loadedAtText = formatIstTimestamp(loadedAt);
    const loadedAge = formatAge(loadedAt);
    const latestTleAgeHours = Number(data.latest_tle_age_hours);
    const latestTleIsRecent = Number.isFinite(latestTleAgeHours) && latestTleAgeHours <= 4;
    const sourceIsCurrent = data.plot_data_current === true && isCelestrak;
    const sourceStatus = sourceIsCurrent ? 'CelesTrak current' : isCelestrak && !latestTleIsRecent ? 'CelesTrak stale' : 'Local fallback - may be stale';
    const loadedLabel = isCelestrak ? 'CelesTrak fetched' : 'Catalog loaded';
    const attemptAge = formatAge(data.celestrak_last_attempt_at_utc);
    const staleReason = sourceIsCurrent
      ? ''
      : `<tr><td colspan="2" class="freshness-warning">Using the newest cached/local catalog available while CelesTrak refresh is unavailable.</td></tr>`;
    const errorRow = data.celestrak_last_error
      ? `<tr><td>CelesTrak error</td><td><small>${data.celestrak_last_error}</small></td></tr>`
      : '';

    this.infoEl.innerHTML = `
      <div class="info-panel-header">
        <div class="iss-title">Active Satellites</div>
        <button class="panel-close-button" type="button" data-close-info-panel aria-label="Close active satellites panel">x</button>
      </div>
      <div class="iss-time">Propagated ${istStr} IST</div>
      <table class="iss-table">
        <tr><td>Visible</td><td id="visible-count">${this._visibleIndices.length.toLocaleString()}</td></tr>
        <tr><td>Tracked</td><td>${data.propagated.toLocaleString()}</td></tr>
        <tr><td>Catalog</td><td>${data.catalog.toLocaleString()}</td></tr>
        <tr><td>Skipped</td><td>${data.skipped.toLocaleString()}</td></tr>
        <tr><th colspan="2">Selected Lat / Long</th></tr>
        <tr><td>Latitude</td><td id="selected-lat">--</td></tr>
        <tr><td>Longitude</td><td id="selected-lon">--</td></tr>
        <tr><td>TLE epoch</td><td id="selected-tle-epoch">--</td></tr>
        <tr><th colspan="2">Source</th></tr>
        ${staleReason}
        <tr><td>Status</td><td>${sourceStatus}</td></tr>
        <tr><td>${loadedLabel}</td><td>${loadedAtText}${loadedAge ? `<br><small>${loadedAge}</small>` : ''}</td></tr>
        <tr><td>Latest TLE epoch</td><td>${formatIstTimestamp(data.latest_tle_epoch_utc)}${formatAge(data.latest_tle_epoch_utc) ? `<br><small>${formatAge(data.latest_tle_epoch_utc)}</small>` : ''}</td></tr>
        <tr><td>CelesTrak attempt</td><td>${formatIstTimestamp(data.celestrak_last_attempt_at_utc)}${attemptAge ? `<br><small>${attemptAge}</small>` : ''}</td></tr>
        ${errorRow}
        <tr><td colspan="2" class="source-cell">${data.tle_source || 'CelesTrak active TLE + SATCAT metadata'}</td></tr>
      </table>
      <div class="ground-map-wrap">
        <div class="ground-map-title">Ground point reference</div>
        <canvas id="ground-map" width="280" height="150" aria-label="Selected satellite ground point map"></canvas>
      </div>
    `;
    this._updateSelectedCoordinatePanel();
    this._drawGroundMap();
  }

  _onPointerMove(event) {
    if (!this.camera || !this.renderer || !this._snapshot || !this._visibleIndices.length) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this._raycaster.setFromCamera(this._pointer, this.camera);
    const [hit] = this._raycaster.intersectObject(this.points);
    if (!hit) {
      this._hideTooltip();
      return;
    }

    const satIndex = this._visibleIndices[hit.index];
    this._hoveredIndex = satIndex;
    this._showTooltip(satIndex, event.clientX, event.clientY);
    this._selectSatellite(satIndex, false);
  }

  _showTooltip(i, x, y) {
    if (!this.tooltipEl) return;
    const geo = this._snapshot.geodetic[i];
    this.tooltipEl.innerHTML = `
      <strong>${this._snapshot.names[i]}</strong>
      <span>NORAD ${this._snapshot.ids[i]} · ${this._snapshot.countries[i]}</span>
      <span>Lat ${formatDeg(geo.lat, 'N', 'S')} · Long ${formatDeg(geo.lon, 'E', 'W')}</span>
      <span>${geo.alt.toFixed(1)} km altitude</span>
    `;
    this.tooltipEl.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
    this.tooltipEl.classList.add('visible');
  }

  _hideTooltip() {
    this._hoveredIndex = -1;
    this.tooltipEl?.classList.remove('visible');
  }

  _selectSatellite(i, showTooltip) {
    if (!this._snapshot || i < 0) return;
    this._selectedIndex = i;
    const i3 = i * 3;
    this.selectedMarker.position.set(
      this._snapshot.display[i3],
      this._snapshot.display[i3 + 1],
      this._snapshot.display[i3 + 2],
    );
    this.selectedGlow.position.copy(this.selectedMarker.position);
    this.selectedMarker.visible = this.viewMode === '3d';
    this.selectedGlow.visible = this.viewMode === '3d';

    if (showTooltip) {
      const vector = this.selectedMarker.getWorldPosition(new THREE.Vector3()).project(this.camera);
      const x = (vector.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-vector.y * 0.5 + 0.5) * window.innerHeight;
      this._showTooltip(i, x, y);
    }
    this._updateSelectedCoordinatePanel();
    this._rebuildOrbitals(true);
    this._drawGroundMap(i);
    this._drawMapView(true);
  }

  _updateSelectedCoordinatePanel(index = this._selectedIndex >= 0 ? this._selectedIndex : this._issIndex) {
    if (!this._snapshot || index < 0) return;
    const geo = this._snapshot.geodetic[index];
    const latEl = document.getElementById('selected-lat');
    const lonEl = document.getElementById('selected-lon');
    const epochEl = document.getElementById('selected-tle-epoch');
    if (latEl) latEl.textContent = formatDeg(geo.lat, 'N', 'S');
    if (lonEl) lonEl.textContent = formatDeg(geo.lon, 'E', 'W');
    if (epochEl) {
      const epoch = this._snapshot.epoch_utc?.[index];
      const age = formatAge(epoch);
      epochEl.innerHTML = `${formatIstTimestamp(epoch)}${age ? `<br><small>${age}</small>` : ''}`;
    }
  }

  _drawGroundMap(index = this._selectedIndex >= 0 ? this._selectedIndex : this._issIndex) {
    const canvas = document.getElementById('ground-map');
    if (!(canvas instanceof HTMLCanvasElement) || !this._snapshot) return;
    this._lastGroundMapDrawMs = Date.now();

    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    if (this._mapImage.complete && this._mapImage.naturalWidth > 0) {
      ctx.drawImage(this._mapImage, 0, 0, width, height);
    } else {
      ctx.fillStyle = '#07111a';
      ctx.fillRect(0, 0, width, height);
    }

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.34)';
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.lineWidth = 1;
    ctx.font = '9px Space Mono, monospace';
    ctx.textBaseline = 'middle';

    for (let lon = -180; lon <= 180; lon += 60) {
      const x = ((lon + 180) / 360) * width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.strokeStyle = lon === 0 ? 'rgba(0,255,170,0.85)' : 'rgba(255,255,255,0.28)';
      ctx.stroke();
      if (lon > -180 && lon < 180) {
        ctx.textAlign = 'center';
        const label = lon === 0 ? '0' : `${Math.abs(lon)}${lon > 0 ? 'E' : 'W'}`;
        ctx.fillText(label, x, height / 2 + 13);
      }
    }

    for (let lat = -60; lat <= 60; lat += 30) {
      const y = ((90 - lat) / 180) * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.strokeStyle = lat === 0 ? 'rgba(0,200,224,0.85)' : 'rgba(255,255,255,0.28)';
      ctx.stroke();
    }

    if (index >= 0) {
      const geo = this._snapshot.geodetic[index];
      const x = ((geo.lon + 180) / 360) * width;
      const y = ((90 - geo.lat) / 180) * height;
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(0, 0, width, 18);
      ctx.fillStyle = '#e8f4f8';
      ctx.textAlign = 'left';
      ctx.fillText(`${this._snapshot.names[index]} ${formatDeg(geo.lat, 'N', 'S')}, ${formatDeg(geo.lon, 'E', 'W')}`, 7, 9);

      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#00ffaa';
      ctx.stroke();
    }

    ctx.restore();
  }

  update() {
    if (!this._snapshot) return;
    this._fillCurrentState();
    const attr = this.points.geometry.attributes.position;
    if (!attr) return;

    for (let row = 0; row < this._visibleIndices.length; row += 1) {
      const satIndex = this._visibleIndices[row];
      const src = satIndex * 3;
      const dst = row * 3;
      attr.array[dst] = this._snapshot.display[src];
      attr.array[dst + 1] = this._snapshot.display[src + 1];
      attr.array[dst + 2] = this._snapshot.display[src + 2];
    }

    attr.needsUpdate = true;
    if (this._hoveredIndex >= 0) this._selectSatellite(this._hoveredIndex, false);
    this._updateSelectedCoordinatePanel();
    if (Date.now() - this._lastGroundMapDrawMs > 1000) this._drawGroundMap();
    this._drawMapView();
  }

  resize() {
    this._drawMapView(true);
    this._updateAnalyticsPanel();
  }
}
