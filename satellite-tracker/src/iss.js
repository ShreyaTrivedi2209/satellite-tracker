/**
 * ISSTracker — polls /api/iss for ECEF state, then extrapolates
 * position every frame for smooth orbit motion (no 2-second jumps).
 */

import * as THREE from 'three';

const EARTH_RADIUS_KM = 6371;
const POLL_INTERVAL_MS = 30000;

export class ISSTracker {
  constructor(earthGroup, infoEl) {
    this.earthGroup = earthGroup;
    this.infoEl = infoEl;

    this.data = null;
    this._fetching = false;
    this._snapshot = null; // { x,y,z, vx,vy,vz, timeMs }

    this._buildMarker();
    this._startPolling();
  }

  _buildMarker() {
    const geo = new THREE.SphereGeometry(0.012, 16, 16);
    const mat = new THREE.MeshBasicMaterial({ color: 0xFFFFFF });
    this.marker = new THREE.Mesh(geo, mat);
    this.marker.visible = false;

    const ringGeo = new THREE.RingGeometry(0.018, 0.022, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00FFAA,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.8,
    });
    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.visible = false;

    const glowGeo = new THREE.SphereGeometry(0.02, 16, 16);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x00FFAA,
      transparent: true,
      opacity: 0.3,
    });
    this.glow = new THREE.Mesh(glowGeo, glowMat);
    this.glow.visible = false;

    this.earthGroup.add(this.marker);
    this.earthGroup.add(this.glow);
    this.earthGroup.add(this.ring);
  }

  _startPolling() {
    const poll = async () => {
      if (this._fetching) return;
      this._fetching = true;
      try {
        const res = await fetch('/api/iss');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.data = await res.json();
        this._applySnapshot(this.data);
        this._updateInfoPanel();
      } catch (e) {
        console.warn('[ISS] Fetch error:', e.message);
        if (this.infoEl && !this.data) {
          this.infoEl.innerHTML = `<span style="color:#ff4444">⚠ Cannot reach ISS server.<br>Is python/server.py running?</span>`;
        }
      } finally {
        this._fetching = false;
      }
    };

    poll();
    setInterval(poll, POLL_INTERVAL_MS);
  }

  _applySnapshot(data) {
    const { ecef, timestamp_utc } = data;
    this._snapshot = {
      x: ecef.x,
      y: ecef.y,
      z: ecef.z,
      vx: ecef.vx,
      vy: ecef.vy,
      vz: ecef.vz,
      timeMs: Date.parse(timestamp_utc),
    };
    this._setMarkerPosition(this._currentEcef());
  }

  _currentEcef() {
    if (!this._snapshot) return null;
    const dt = (Date.now() - this._snapshot.timeMs) / 1000;
    const s = this._snapshot;
    return {
      x: s.x + s.vx * dt,
      y: s.y + s.vy * dt,
      z: s.z + s.vz * dt,
    };
  }

  _ecefToVec3(x, y, z) {
    const scale = 1 / EARTH_RADIUS_KM;
    return new THREE.Vector3(x * scale, y * scale, z * scale);
  }

  _setMarkerPosition(ecef) {
    if (!ecef) return;
    const pos = this._ecefToVec3(ecef.x, ecef.y, ecef.z);

    this.marker.position.copy(pos);
    this.glow.position.copy(pos);
    this.ring.position.copy(pos);

    this.marker.visible = true;
    this.glow.visible = true;
    this.ring.visible = true;
  }

  _updateInfoPanel() {
    if (!this.data || !this.infoEl) return;
    const { geodetic, ecef, eci, speed_km_s, timestamp_utc } = this.data;

    const utcDate = new Date(timestamp_utc);
    const istStr = utcDate.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
    });

    this.infoEl.innerHTML = `
      <div class="iss-title">🛰 ISS (ZARYA)</div>
      <div class="iss-time">Updated: ${istStr} IST</div>
      <table class="iss-table">
        <tr><th colspan="2">📍 Geodetic</th></tr>
        <tr><td>Latitude</td><td>${geodetic.lat.toFixed(4)}°</td></tr>
        <tr><td>Longitude</td><td>${geodetic.lon.toFixed(4)}°</td></tr>
        <tr><td>Altitude</td><td>${geodetic.alt_km.toFixed(1)} km</td></tr>
        <tr><th colspan="2">🌍 ECEF (km)</th></tr>
        <tr><td>X</td><td>${ecef.x.toFixed(1)}</td></tr>
        <tr><td>Y</td><td>${ecef.y.toFixed(1)}</td></tr>
        <tr><td>Z</td><td>${ecef.z.toFixed(1)}</td></tr>
        <tr><th colspan="2">📡 ECI (km)</th></tr>
        <tr><td>X</td><td>${eci.x.toFixed(1)}</td></tr>
        <tr><td>Y</td><td>${eci.y.toFixed(1)}</td></tr>
        <tr><td>Z</td><td>${eci.z.toFixed(1)}</td></tr>
        <tr><th colspan="2">⚡ Speed</th></tr>
        <tr><td>Velocity</td><td>${speed_km_s.toFixed(3)} km/s</td></tr>
      </table>
    `;
  }

  update(camera) {
    const ecef = this._currentEcef();
    if (ecef) {
      this._setMarkerPosition(ecef);
    }
    if (this.ring.visible) {
      this.ring.quaternion.copy(camera.quaternion);
    }
  }
}
