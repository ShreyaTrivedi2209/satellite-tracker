import * as THREE from 'three';
import { getFresnelMat } from './getFresnelMat.js';

const EARTH_TEXTURE_SRC = '/textures/00_earthmap1k.jpg';
const TEXTURE_WIDTH = 2048;
const TEXTURE_HEIGHT = 1024;

function lonToX(lon) {
  return ((lon + 180) / 360) * TEXTURE_WIDTH;
}

function latToY(lat) {
  return ((90 - lat) / 180) * TEXTURE_HEIGHT;
}

function formatCoord(value, positive, negative) {
  if (value === 0) return '0';
  return `${Math.abs(value)}${value > 0 ? positive : negative}`;
}

function drawLabeledMap(ctx, earthImage) {
  ctx.clearRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
  ctx.drawImage(earthImage, 0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);

  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.font = '24px Space Mono, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let lon = -180; lon <= 180; lon += 30) {
    const x = lonToX(lon);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, TEXTURE_HEIGHT);
    ctx.strokeStyle = lon === 0 ? 'rgba(0, 255, 170, 0.86)' : 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = lon === 0 ? 3 : 1.5;
    ctx.stroke();

    if (lon > -180 && lon < 180 && lon % 60 === 0) {
      ctx.fillText(formatCoord(lon, 'E', 'W'), x, TEXTURE_HEIGHT / 2 + 34);
    }
  }

  for (let lat = -60; lat <= 60; lat += 30) {
    const y = latToY(lat);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(TEXTURE_WIDTH, y);
    ctx.strokeStyle = lat === 0 ? 'rgba(0, 200, 224, 0.9)' : 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = lat === 0 ? 3 : 1.5;
    ctx.stroke();

    if (lat !== 0) {
      ctx.textAlign = 'left';
      ctx.fillText(formatCoord(lat, 'N', 'S'), 18, y);
      ctx.textAlign = 'right';
      ctx.fillText(formatCoord(lat, 'N', 'S'), TEXTURE_WIDTH - 18, y);
      ctx.textAlign = 'center';
    }
  }

  ctx.fillStyle = 'rgba(0, 255, 170, 0.96)';
  ctx.fillText('Prime meridian', lonToX(0), TEXTURE_HEIGHT / 2 - 34);
  ctx.fillStyle = 'rgba(0, 200, 224, 0.96)';
  ctx.fillText('Equator', lonToX(-138), latToY(0) - 24);
  ctx.restore();
}

function createLabeledEarthTexture(loader) {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_WIDTH;
  canvas.height = TEXTURE_HEIGHT;
  const ctx = canvas.getContext('2d');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;

  ctx.fillStyle = '#07111a';
  ctx.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);

  loader.load(EARTH_TEXTURE_SRC, (earthTexture) => {
    drawLabeledMap(ctx, earthTexture.image);
    texture.needsUpdate = true;
  });

  return texture;
}

export function createEarth() {
  const earthGroup = new THREE.Group();

  const loader = new THREE.TextureLoader();
  const geometry = new THREE.SphereGeometry(1, 96, 48);

  // Evenly lit — no directional day/night shading
  const material = new THREE.MeshBasicMaterial({
    map: createLabeledEarthTexture(loader),
  });
  const earthMesh = new THREE.Mesh(geometry, material);
  earthGroup.add(earthMesh);

  // Fresnel Atmosphere
  const fresnelMat = getFresnelMat();
  const glowMesh = new THREE.Mesh(geometry, fresnelMat);
  glowMesh.scale.setScalar(1.01);
  earthGroup.add(glowMesh);

  return { earthGroup, earthMesh };
}
