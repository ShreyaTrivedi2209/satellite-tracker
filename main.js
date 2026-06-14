import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createEarth } from './src/earth.js';
import getStarfield from './src/getStarfield.js';
import { SatelliteTracker } from './src/satellites.js';

const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 0.25, 3);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 1.2;
controls.maxDistance = 15;

const { earthGroup } = createEarth();
scene.add(earthGroup);

const stars = getStarfield({ numStars: 2000 });
scene.add(stars);

const infoEl = document.getElementById('iss-info');
const satelliteTracker = new SatelliteTracker(earthGroup, infoEl, {
  camera,
  renderer,
  container,
  mapCanvas: document.getElementById('map-view'),
});

function animate() {
  requestAnimationFrame(animate);
  satelliteTracker.update();
  if (satelliteTracker.viewMode === '3d') {
    controls.update();
    renderer.render(scene, camera);
  }
}

animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
