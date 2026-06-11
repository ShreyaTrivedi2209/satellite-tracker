import * as THREE from 'three';

const EARTH_RADIUS_KM = 6371;
const POLL_INTERVAL_MS = 60000;
const ISS_NORAD = '25544';
const KM_SCALE = 1 / EARTH_RADIUS_KM;
const CELESTRAK_2LE = '/api/celestrak/NORAD/elements/gp.php?GROUP=active&FORMAT=tle';

const DEFAULT_FILTERS = {
  search: '',
  country: 'all',
  altitudeBand: 'all',
  inclination: [0, 180],
  eccentricityMax: 1,
  meanMotion: [0, 20],
};

export function ecefKmToThree(x, y, z) {
  const r = Math.hypot(x, y, z) * KM_SCALE;
  if (!Number.isFinite(r) || r === 0) return new THREE.Vector3();
  const lat = Math.asin(z / Math.hypot(x, y, z));
  const lon = Math.atan2(y, x);
  const cosLat = Math.cos(lat);

  return new THREE.Vector3(
    -r * cosLat * Math.cos(lon),
    r * Math.sin(lat),
    r * cosLat * Math.sin(lon),
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
  return `${Math.abs(value).toFixed(3)}° ${suffix}`;
}

function altitudeBand(alt) {
  if (alt < 2000) return 'leo';
  if (alt < 35786 - 1500) return 'meo';
  if (alt < 35786 + 1500) return 'geo';
  return 'heo';
}

export class SatelliteTracker {
  constructor(earthGroup, infoEl, options = {}) {
    this.earthGroup = earthGroup;
    this.infoEl = infoEl;
    this.camera = options.camera;
    this.renderer = options.renderer;
    this.container = options.container ?? document.body;
    this.tooltipEl = options.tooltipEl ?? document.getElementById('sat-tooltip');
    this.controlsEl = options.controlsEl ?? document.getElementById('sat-controls');
    this.resultsEl = options.resultsEl ?? document.getElementById('search-results');

    this._fetching = false;
    this._snapshot = null;
    this._filters = { ...DEFAULT_FILTERS };
    this._visibleIndices = [];
    this._issIndex = -1;
    this._hoveredIndex = -1;
    this._pointer = new THREE.Vector2();
    this._raycaster = new THREE.Raycaster();
    this._raycaster.params.Points.threshold = 0.025;

    this._buildPoints();
    this._buildSelectedMarker();
    this._bindUi();
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
      const chip = event.target.closest('[data-altitude-band]');
      if (chip) {
        this._filters.altitudeBand = chip.dataset.altitudeBand;
        this.controlsEl.querySelectorAll('[data-altitude-band]').forEach((node) => {
          node.classList.toggle('active', node === chip);
        });
        this._rebuildVisibleGeometry();
        return;
      }

      const result = event.target.closest('[data-sat-index]');
      if (result) {
        this._selectSatellite(Number(result.dataset.satIndex), true);
      }
    });

    this.renderer?.domElement.addEventListener('pointermove', (event) => this._onPointerMove(event));
    this.renderer?.domElement.addEventListener('pointerleave', () => this._hideTooltip());
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

    for (let i = 0; i < count; i += 1) {
      const j = i * 6;
      pos[i * 3] = data.ecef[j];
      pos[i * 3 + 1] = data.ecef[j + 1];
      pos[i * 3 + 2] = data.ecef[j + 2];
      vel[i * 3] = data.ecef[j + 3];
      vel[i * 3 + 1] = data.ecef[j + 4];
      vel[i * 3 + 2] = data.ecef[j + 5];
    }

    this._issIndex = data.ids.indexOf(ISS_NORAD);
    this._snapshot = {
      ...data,
      count,
      pos,
      vel,
      display: new Float32Array(count * 3),
      geodetic: Array.from({ length: count }, () => ({ lat: 0, lon: 0, alt: 0 })),
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
    const dt = (Date.now() - this._snapshot.timeMs) / 1000;
    const { count, pos, vel, display, geodetic } = this._snapshot;

    for (let i = 0; i < count; i += 1) {
      const i3 = i * 3;
      const x = pos[i3] + vel[i3] * dt;
      const y = pos[i3 + 1] + vel[i3 + 1] * dt;
      const z = pos[i3 + 2] + vel[i3 + 2] * dt;
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
    this.points.visible = visible.length > 0;
    this._renderSearchResults();
    this._updateCounts();
  }

  _renderSearchResults() {
    if (!this.resultsEl || !this._snapshot) return;
    const rows = this._visibleIndices.slice(0, 8).map((satIndex) => {
      const geo = this._snapshot.geodetic[satIndex];
      return `
        <button type="button" class="search-result" data-sat-index="${satIndex}">
          <span>${this._snapshot.names[satIndex]}</span>
          <small>${this._snapshot.ids[satIndex]} · ${geo.alt.toFixed(0)} km</small>
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

    this.infoEl.innerHTML = `
      <div class="iss-title">Active Satellites</div>
      <div class="iss-time">Updated ${istStr} IST</div>
      <table class="iss-table">
        <tr><td>Visible</td><td id="visible-count">${this._visibleIndices.length.toLocaleString()}</td></tr>
        <tr><td>Tracked</td><td>${data.propagated.toLocaleString()}</td></tr>
        <tr><td>Catalog</td><td>${data.catalog.toLocaleString()}</td></tr>
        <tr><td>Skipped</td><td>${data.skipped.toLocaleString()}</td></tr>
        <tr><th colspan="2">Source</th></tr>
        <tr><td colspan="2" class="source-cell">CelesTrak active TLE + SATCAT metadata</td></tr>
      </table>
    `;
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
      <span>${formatDeg(geo.lat, 'N', 'S')}, ${formatDeg(geo.lon, 'E', 'W')}</span>
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
    const i3 = i * 3;
    this.selectedMarker.position.set(
      this._snapshot.display[i3],
      this._snapshot.display[i3 + 1],
      this._snapshot.display[i3 + 2],
    );
    this.selectedGlow.position.copy(this.selectedMarker.position);
    this.selectedMarker.visible = true;
    this.selectedGlow.visible = true;

    if (showTooltip) {
      const vector = this.selectedMarker.getWorldPosition(new THREE.Vector3()).project(this.camera);
      const x = (vector.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-vector.y * 0.5 + 0.5) * window.innerHeight;
      this._showTooltip(i, x, y);
    }
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
  }
}
