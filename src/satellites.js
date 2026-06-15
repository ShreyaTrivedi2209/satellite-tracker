import * as THREE from 'three';

const EARTH_RADIUS_KM = 6371;
const POLL_INTERVAL_MS = 5000;
const ISS_NORAD = '25544';
const KM_SCALE = 1 / EARTH_RADIUS_KM;
const EARTH_MU_KM3_S2 = 398600.4418;
const CELESTRAK_2LE = '/api/celestrak/NORAD/elements/gp.php?GROUP=active&FORMAT=tle';
const EARTH_MAP_SRC = '/textures/00_earthmap1k.jpg';
const ORBIT_SAMPLE_COUNT = 160;
const ORBIT_VISIBLE_LIMIT = 24;

const DEFAULT_FILTERS = {
  search: '',
  country: 'all',
  altitudeBand: 'all',
  inclination: [0, 180],
  eccentricityMax: 1,
  meanMotion: [0, 20],
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

    this._fetching = false;
    this._snapshot = null;
    this.viewMode = '3d';
    this._showOrbitals = false;
    this._filters = { ...DEFAULT_FILTERS };
    this._visibleIndices = [];
    this._issIndex = -1;
    this._selectedIndex = -1;
    this._hoveredIndex = -1;
    this._lastGroundMapDrawMs = 0;
    this._lastMapDrawMs = 0;
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
    this._bindUi();
    this._setViewMode(this.viewMode);
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

    this.renderer?.domElement.addEventListener('pointermove', (event) => this._onPointerMove(event));
    this.renderer?.domElement.addEventListener('pointerleave', () => this._hideTooltip());
    this.mapCanvas?.addEventListener('pointermove', (event) => this._onMapPointerMove(event));
    this.mapCanvas?.addEventListener('click', (event) => this._onMapClick(event));
    this.mapCanvas?.addEventListener('pointerleave', () => this._hideTooltip());
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

    if ((data.catalog ?? 0) < 100) {
      try {
        const tleRes = await fetch(CELESTRAK_2LE);
        if (tleRes.ok) {
          const tleText = await tleRes.text();
          res = await fetch('/api/satellites', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: tleText,
          });
          if (res.ok) {
            data = await res.json();
            if (!data.error) return data;
          }
        }
      } catch (e) {
        console.warn('[Satellites] CelesTrak proxy fallback:', e.message);
      }
    }

    return data;
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

    return (!query || haystack.includes(query))
      && (this._filters.country === 'all' || s.countries[i] === this._filters.country)
      && (this._filters.altitudeBand === 'all' || altitudeBand(geo.alt) === this._filters.altitudeBand)
      && s.inclinations[i] >= this._filters.inclination[0]
      && s.inclinations[i] <= this._filters.inclination[1]
      && s.eccentricities[i] <= this._filters.eccentricityMax
      && s.mean_motion[i] >= this._filters.meanMotion[0]
      && s.mean_motion[i] <= this._filters.meanMotion[1];
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

  _syncRangeLabels() {
    document.getElementById('inclination-label').textContent = `${this._filters.inclination[0]}° - ${this._filters.inclination[1]}°`;
    document.getElementById('eccentricity-label').textContent = `≤ ${this._filters.eccentricityMax.toFixed(2)}`;
    document.getElementById('mean-motion-label').textContent = `${this._filters.meanMotion[0]} - ${this._filters.meanMotion[1]} rev/day`;
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
    const sourceStatus = isCelestrak ? 'CelesTrak' : 'Local fallback';
    const loadedLabel = isCelestrak ? 'CelesTrak fetched' : 'Catalog loaded';

    this.infoEl.innerHTML = `
      <div class="iss-title">Active Satellites</div>
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
        <tr><td>Status</td><td>${sourceStatus}</td></tr>
        <tr><td>${loadedLabel}</td><td>${loadedAtText}${loadedAge ? `<br><small>${loadedAge}</small>` : ''}</td></tr>
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
}
