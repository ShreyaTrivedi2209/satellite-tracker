import * as THREE from 'three';
import { getFresnelMat } from './getFresnelMat.js';

export function createEarth() {
  const earthGroup = new THREE.Group();
  earthGroup.rotation.z = -23.4 * Math.PI / 180;

  const loader = new THREE.TextureLoader();
  const geometry = new THREE.IcosahedronGeometry(1, 12);

  // Evenly lit — no directional day/night shading
  const material = new THREE.MeshBasicMaterial({
    map: loader.load('/textures/00_earthmap1k.jpg'),
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
