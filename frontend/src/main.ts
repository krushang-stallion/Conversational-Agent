/* Legacy particle-cloud implementation retained below for reference.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

// --- CONFIGURATION ---
const PARTICLE_COUNT = 8000; // Drastically increased for dense look
const GOLD_BASE = new THREE.Color('#d4af37');   // Base gold
const GOLD_BRIGHT = new THREE.Color('#fff7cc'); // Bright core/highlight
const GOLD_DIM = new THREE.Color('#5c4a17');    // Dim for outer layers

// 1. Scene Setup
const container = document.getElementById('canvas-container')!;
const labelContainer = document.getElementById('label-container')!;
const statusOverlay = document.getElementById('status-overlay')!;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x050505, 0.05); // Deeper fog

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 16);

// WebGL Renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
container.appendChild(renderer.domElement);

// CSS2D Renderer
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.top = '0px';
labelContainer.appendChild(labelRenderer.domElement);

const controls = new OrbitControls(camera, labelRenderer.domElement);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.2;

// Post-Processing (Crucial for the glow)
const renderPass = new RenderPass(scene, camera);
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  1.8,  // Strength
  0.5,  // Radius
  0.2   // Threshold
);
const composer = new EffectComposer(renderer);
composer.addPass(renderPass);
composer.addPass(bloomPass);

// 2. Data Clusters & Dense Particle System
interface Cluster {
  name: string;
  center: THREE.Vector3;
  indices: number[];
  active: boolean;
  htmlElement: HTMLDivElement;
}

const clusters: Record<string, Cluster> = {
  database: { name: 'PostgreSQL DB', center: new THREE.Vector3(-4, 2, 2), indices: [], active: false, htmlElement: null! },
  knowledge_base: { name: 'Vector Store', center: new THREE.Vector3(4, -1, -2), indices: [], active: false, htmlElement: null! },
  api: { name: 'External API', center: new THREE.Vector3(0, -4, 3), indices: [], active: false, htmlElement: null! }
};

const sphereGroup = new THREE.Group();
scene.add(sphereGroup);

const positions: number[] = [];
const originalPositions: THREE.Vector3[] = [];
const colors: number[] = [];
const sizes: number[] = [];
const baseRadii: number[] = []; // Store original distance from center

// Generate Dense Concentric Layers
for (let i = 0; i < PARTICLE_COUNT; i++) {
  // Distribute mostly towards the core, tapering off
  const u = Math.random();
  const radius = 6 * Math.pow(u, 0.5) + (Math.random() * 0.5); // Core bias

  const phi = Math.acos(1 - 2 * Math.random());
  const theta = Math.random() * 2 * Math.PI;

  const pos = new THREE.Vector3(
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.sin(phi) * Math.sin(theta),
    radius * Math.cos(phi)
  );

  positions.push(pos.x, pos.y, pos.z);
  originalPositions.push(pos);
  baseRadii.push(radius);

  // Color based on distance from center (core is bright, edges are dim)
  let initialColor = GOLD_BASE.clone();
  if (radius < 2.5) {
      initialColor.lerp(GOLD_BRIGHT, 0.6);
  } else if (radius > 5) {
      initialColor.lerp(GOLD_DIM, 0.7);
  }

  colors.push(initialColor.r, initialColor.g, initialColor.b);
  sizes.push(radius < 2.5 ? 1.5 : 0.6); // Core particles slightly larger
}

// Assign particles near clusters for activation effects
for (let i = 0; i < PARTICLE_COUNT; i++) {
    const pos = originalPositions[i];
    for (const key in clusters) {
        if (pos.distanceTo(clusters[key].center) < 1.8) {
            clusters[key].indices.push(i);
        }
    }
}

// Attach HTML Labels
for (const key in clusters) {
  const cluster = clusters[key];
  const div = document.createElement('div');
  div.className = 'node-label';
  div.textContent = cluster.name;
  cluster.htmlElement = div;
  
  const labelObject = new CSS2DObject(div);
  labelObject.position.copy(cluster.center);
  sphereGroup.add(labelObject);
}


const pointGeometry = new THREE.BufferGeometry();
pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
pointGeometry.setAttribute('customColor', new THREE.Float32BufferAttribute(colors, 3));
pointGeometry.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1));
// Custom attribute to hold original positions for shaders if needed, but we'll use JS animation here

const pointMaterial = new THREE.ShaderMaterial({
  vertexShader: `
    attribute float size;
    attribute vec3 customColor;
    varying vec3 vColor;
    void main() {
      vColor = customColor;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      // Size attenuation based on depth
      gl_PointSize = size * (250.0 / -mvPosition.z);
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
  fragmentShader: `
    varying vec3 vColor;
    void main() {
      // Create a soft circle
      float dist = length(gl_PointCoord - vec2(0.5));
      if (dist > 0.5) discard;
      float alpha = smoothstep(0.5, 0.1, dist);
      gl_FragColor = vec4(vColor, alpha);
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending
});

const particleSystem = new THREE.Points(pointGeometry, pointMaterial);
sphereGroup.add(particleSystem);


// 3. UI MOCK CONTROLLER & STATE LOGIC
let currentState: 'idle' | 'thinking' | 'speaking' = 'idle';

function resetStates() {
  currentState = 'idle';
  Object.values(clusters).forEach(c => {
    c.active = false;
    c.htmlElement.classList.remove('active');
  });
  document.querySelectorAll('#demo-controls button').forEach(b => b.classList.remove('active'));
  statusOverlay.innerText = 'AI STATE: IDLE';
}

document.getElementById('btn-idle')!.onclick = (e) => {
  resetStates();
  (e.target as HTMLElement).classList.add('active');
};

document.getElementById('btn-db')!.onclick = (e) => {
  resetStates();
  currentState = 'thinking';
  clusters['database'].active = true;
  clusters['database'].htmlElement.classList.add('active');
  (e.target as HTMLElement).classList.add('active');
  statusOverlay.innerText = 'AI STATE: QUERYING POSTGRES...';
};

document.getElementById('btn-kb')!.onclick = (e) => {
  resetStates();
  currentState = 'thinking';
  clusters['knowledge_base'].active = true;
  clusters['knowledge_base'].htmlElement.classList.add('active');
  (e.target as HTMLElement).classList.add('active');
  statusOverlay.innerText = 'AI STATE: SEARCHING VECTOR STORE...';
};

document.getElementById('btn-speak')!.onclick = (e) => {
  resetStates();
  currentState = 'speaking';
  (e.target as HTMLElement).classList.add('active');
  statusOverlay.innerText = 'AI STATE: SYNTHESIZING VOICE...';
};


// 4. Animation Loop
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  controls.update();

  const elapsedTime = clock.getElapsedTime();
  
  // Base rotation
  sphereGroup.rotation.y = elapsedTime * 0.05;
  sphereGroup.rotation.z = Math.sin(elapsedTime * 0.02) * 0.05;

  const colorAttr = pointGeometry.getAttribute('customColor') as THREE.BufferAttribute;
  const sizeAttr = pointGeometry.getAttribute('size') as THREE.BufferAttribute;
  const posAttr = pointGeometry.getAttribute('position') as THREE.BufferAttribute;

  const speakingPulse = currentState === 'speaking' ? (Math.sin(elapsedTime * 3.0) * 0.5 + 0.5) : 0.0;

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const origPos = originalPositions[i];
    const r = baseRadii[i];
    
    // Default Idle State
    let targetColor = GOLD_BASE.clone();
    if (r < 2.5) targetColor.lerp(GOLD_BRIGHT, 0.6);
    else if (r > 5) targetColor.lerp(GOLD_DIM, 0.7);
    
    let targetSize = r < 2.5 ? 1.5 : 0.6;
    
    // Slight idle noise movement
    const noiseX = Math.sin(elapsedTime * 0.5 + origPos.y) * 0.05;
    const noiseY = Math.cos(elapsedTime * 0.6 + origPos.z) * 0.05;
    
    posAttr.setXYZ(i, origPos.x + noiseX, origPos.y + noiseY, origPos.z);

    // Speaking State: Overall gentle glow and slight expansion
    if (currentState === 'speaking') {
      targetSize += speakingPulse * 0.8;
      targetColor.lerp(GOLD_BRIGHT, speakingPulse * 0.5);
    }

    // Thinking/Querying State: Active clusters glow brightly
    for (const key in clusters) {
      const cluster = clusters[key];
      if (cluster.active && cluster.indices.includes(i)) {
          // Intense pulse for active cluster particles
          const pulse = Math.sin(elapsedTime * 15.0 + i) * 0.5 + 0.5;
          targetColor = GOLD_BRIGHT.clone().lerp(new THREE.Color('#ffffff'), pulse);
          targetSize = 2.0 + pulse * 1.5;
      }
    }

    colorAttr.setXYZ(i, targetColor.r, targetColor.g, targetColor.b);
    sizeAttr.setX(i, targetSize);
  }

  posAttr.needsUpdate = true;
  colorAttr.needsUpdate = true;
  sizeAttr.needsUpdate = true;

  composer.render();
  labelRenderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});
*/

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

const GOLD = new THREE.Color('#d9b84e');
const BRIGHT = new THREE.Color('#fff3a1');
const DEEP_GOLD = new THREE.Color('#705719');
const TAU = Math.PI * 2;

const canvasContainer = document.querySelector<HTMLElement>('#canvas-container')!;
const labelContainer = document.querySelector<HTMLElement>('#label-container')!;
const startLabel = document.querySelector<HTMLElement>('#start-label')!;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#070806');
scene.fog = new THREE.FogExp2('#070806', 0.023);

let sphereState: 'compressed' | 'expanding' | 'expanded' | 'compressing' = 'compressed';
let nodesState: 'hidden' | 'expanding' | 'expanded' | 'compressing' = 'hidden';
labelContainer.style.display = 'none';
const sphereShells: THREE.Points[] = [];
const nodesGroup = new THREE.Group();
nodesGroup.scale.set(0.001, 0.001, 0.001);
nodesGroup.visible = false;
scene.add(nodesGroup);

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0.15, 20.6);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
canvasContainer.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelContainer.appendChild(labelRenderer.domElement);

const controls = new OrbitControls(camera, labelRenderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.045;
controls.enablePan = false;
controls.minDistance = 15;
controls.maxDistance = 27;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.18;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1.2, 0.55, 0.3));

const materialAnimations: THREE.ShaderMaterial[] = [];
const globe = new THREE.Group();
globe.rotation.x = -0.025;
scene.add(globe);

function makePointMaterial(scale: number, opacity: number) {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      time: { value: 0 },
      scale: { value: scale },
      opacity: { value: opacity }
    },
    vertexShader: `
      attribute float aSize;
      attribute float aPhase;
      attribute vec3 aColor;
      uniform float time;
      uniform float scale;
      varying vec3 vColor;
      varying float vPulse;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vPulse = 0.78 + sin(time * 1.3 + aPhase) * 0.22;
        vColor = aColor * vPulse;
        gl_PointSize = aSize * scale * (180.0 / -viewPosition.z);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: `
      uniform float opacity;
      varying vec3 vColor;
      varying float vPulse;
      void main() {
        float edge = distance(gl_PointCoord, vec2(0.5));
        if (edge > 0.5) discard;
        float alpha = 1.0 - smoothstep(0.12, 0.5, edge);
        gl_FragColor = vec4(vColor, alpha * opacity * vPulse);
      }
    `
  });
  materialAnimations.push(material);
  return material;
}

function addPointCloud(
  points: THREE.Vector3[],
  colors: THREE.Color[],
  sizes: number[],
  scale: number,
  opacity: number,
  parent: THREE.Object3D = globe
) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(points.length * 3);
  const colorData = new Float32Array(points.length * 3);
  const phases = new Float32Array(points.length);

  points.forEach((point, index) => {
    positions.set([point.x, point.y, point.z], index * 3);
    colorData.set([colors[index].r, colors[index].g, colors[index].b], index * 3);
    phases[index] = Math.random() * TAU;
  });
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colorData, 3));
  geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  const cloud = new THREE.Points(geometry, makePointMaterial(scale, opacity));
  parent.add(cloud);
  return cloud;
}

function addSphereShell(radius: number, latitudes: number, longitudes: number, opacity: number) {
  const points: THREE.Vector3[] = [];
  const colors: THREE.Color[] = [];
  const sizes: number[] = [];
  for (let latitude = 1; latitude < latitudes; latitude++) {
    const phi = (latitude / latitudes) * Math.PI;
    for (let longitude = 0; longitude < longitudes; longitude++) {
      const theta = (longitude / longitudes) * TAU + (latitude % 2) * 0.03;
      const noise = (Math.random() - 0.5) * 0.065;
      const x = (radius + noise) * Math.sin(phi) * Math.cos(theta);
      const y = (radius + noise) * Math.cos(phi);
      const z = (radius + noise) * Math.sin(phi) * Math.sin(theta);
      const facing = Math.max(0, z / radius);
      points.push(new THREE.Vector3(x, y, z));
      colors.push(GOLD.clone().lerp(BRIGHT, 0.22 + facing * 0.52 + Math.random() * 0.18));
      sizes.push(0.22 + facing * 0.31 + Math.random() * 0.14);
    }
  }
  const cloud = addPointCloud(points, colors, sizes, 1, opacity);
  cloud.scale.set(0.001, 0.001, 0.001);
  cloud.visible = false;
  cloud.userData.baseOpacity = opacity;
  (cloud.material as THREE.ShaderMaterial).uniforms.opacity.value = 0;
  sphereShells.push(cloud as THREE.Points);
  return cloud;
}

function addRing(radius: number, opacity: number, tiltX = 0, tiltY = 0, parent: THREE.Object3D = globe) {
  const points: THREE.Vector3[] = [];
  for (let index = 0; index <= 180; index++) {
    const angle = index / 180 * TAU;
    points.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0));
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: GOLD, transparent: true, opacity, blending: THREE.AdditiveBlending
  });
  const ring = new THREE.Line(geometry, material);
  ring.rotation.set(tiltX, tiltY, 0);
  parent.add(ring);
  return ring;
}

function addRadialLattice() {
  const positions: number[] = [];
  for (let index = 0; index < 192; index++) {
    const angle = index / 192 * TAU;
    const radius = 5.05 + Math.sin(index * 2.13) * 0.12;
    positions.push(Math.cos(angle) * 0.62, Math.sin(angle) * 0.62, -0.09);
    positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, -0.09);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  globe.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
    color: GOLD, transparent: true, opacity: 0.21, blending: THREE.AdditiveBlending
  })));
}

function addCore() {
  const points: THREE.Vector3[] = [];
  const colors: THREE.Color[] = [];
  const sizes: number[] = [];
  for (let index = 0; index < 880; index++) {
    const u = Math.random();
    const v = Math.random();
    const theta = u * TAU;
    const phi = Math.acos(2.0 * v - 1.0);
    // Use cube root for a perfectly even, solid spherical volume
    const r = Math.cbrt(Math.random()) * 0.65;
    
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.sin(phi) * Math.sin(theta);
    const z = r * Math.cos(phi);

    points.push(new THREE.Vector3(x, y, z));
    colors.push(GOLD.clone().lerp(BRIGHT, 0.4 + Math.random() * 0.55));
    sizes.push(0.3 + Math.random() * 0.38);
  }
  addPointCloud(points, colors, sizes, 1.05, 1);
  // [0.32, 0.6, 0.95, 1.36].forEach((radius, index) => addRing(radius, 0.84 - index * 0.12));
}

addSphereShell(5.56, 59, 118, 0.9);
addSphereShell(3.74, 53, 106, 0.97);
addSphereShell(2.2, 44, 96, 0.94);
// addRadialLattice();
addCore();
// [2.2, 3.74, 5.56].forEach(radius => addRing(radius, 0.52));
// addRing(5.56, 0.28, Math.PI / 2);
// addRing(5.56, 0.17, 0, Math.PI / 2);
// addRing(6.25, 0.14);
// addRing(7.06, 0.1);



function addBackgroundDust() {
  scene.add(camera);
  const points: THREE.Vector3[] = [];
  const colors: THREE.Color[] = [];
  const sizes: number[] = [];
  for (let index = 0; index < 390; index++) {
    const x = (Math.random() - 0.5) * 80;
    const y = (Math.random() - 0.5) * 80;
    const z = -40 - Math.random() * 20;
    points.push(new THREE.Vector3(x, y, z));
    colors.push(GOLD.clone().lerp(BRIGHT, Math.random() * 0.25));
    sizes.push(Math.random() > 0.91 ? 1.5 : 0.4 + Math.random() * 0.3);
  }
  return addPointCloud(points, colors, sizes, 0.75, 0.68, camera);
}



interface ServiceNode {
  name: string;
  detail: string;
  position: THREE.Vector3;
  hot?: boolean;
}

const services: ServiceNode[] = [
  { name: 'DATABASE', detail: 'POSTGRESQL / 024', position: new THREE.Vector3(-8.32, 0.1, 0) },
  { name: 'AUTH', detail: 'IDENTITY GATEWAY', position: new THREE.Vector3(-6.88, 4.22, 0.1) },
  { name: 'ROUTER', detail: 'NETWORK / 8MS', position: new THREE.Vector3(-7.25, 2.48, 0.1) },
  { name: 'INGEST', detail: 'STREAM / INPUT', position: new THREE.Vector3(-8.55, -2.1, 0.1), hot: true },
  { name: 'METRICS', detail: 'TRACE / 99.98%', position: new THREE.Vector3(-7.15, -3.6, 0.1) },
  { name: 'WORKER', detail: 'QUEUE / 16', position: new THREE.Vector3(-6.25, -4.55, 0.1) },
  { name: 'TOOLS', detail: 'MCP / READY', position: new THREE.Vector3(-4.9, -5.15, 0.1) },
  { name: 'ARCHIVE', detail: 'OBJECT / COLD', position: new THREE.Vector3(-8.72, 3.58, 0.1) },
  { name: 'CORE API', detail: 'SERVICE MESH', position: new THREE.Vector3(8.34, 3.1, 0.1) },
  { name: 'CATALOG', detail: 'INDEX / 188K', position: new THREE.Vector3(6.45, 4.45, 0.1) },
  { name: 'SEARCH', detail: 'QUERY / 12MS', position: new THREE.Vector3(8.98, 1.65, 0.1), hot: true },
  { name: 'VECTOR STORE', detail: 'EMBEDDINGS / LIVE', position: new THREE.Vector3(9.16, 0.14, 0.1), hot: true },
  { name: 'EVENT BUS', detail: 'STREAM / ACTIVE', position: new THREE.Vector3(7.6, -3.95, 0.1) },
  { name: 'ANALYTICS', detail: 'BATCH / 312K', position: new THREE.Vector3(8.52, -2.2, 0.1) },
  { name: 'CACHE', detail: 'REDIS / WARM', position: new THREE.Vector3(4.8, -5.28, 0.1) },
  { name: 'GATEWAY', detail: 'EDGE / TLS', position: new THREE.Vector3(6.15, -4.78, 0.1) },
  { name: 'NOTIFIER', detail: 'EVENT / PUSH', position: new THREE.Vector3(4.45, 5.22, 0.1) },
  { name: 'POLICY', detail: 'RULES / SYNC', position: new THREE.Vector3(-4.65, 5.2, 0.1) }
];

// Map nodes to a completely 3D spherical layout
services.forEach((service, i) => {
  const r2d = Math.sqrt(service.position.x ** 2 + service.position.y ** 2);
  const R = 9.5; // Target sphere radius
  if (r2d < R) {
    let z = Math.sqrt(R * R - r2d * r2d);
    // Alternate z to distribute them around the sphere
    if (i % 2 !== 0) z = -z;
    service.position.z = z;
  }
});

function addCircle(position: THREE.Vector3, radius: number, hot: boolean) {
  const points: THREE.Vector3[] = [];
  const segments = 32;
  for (let index = 0; index <= segments; index++) {
    const angle = index / segments * TAU;
    points.push(new THREE.Vector3(position.x + Math.cos(angle) * radius, position.y + Math.sin(angle) * radius, position.z));
  }
  nodesGroup.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({
      color: hot ? BRIGHT : GOLD, transparent: true, opacity: hot ? 0.93 : 0.6, blending: THREE.AdditiveBlending
    })
  ));
}

function addServiceNetwork() {
  const connections: number[] = [];
  const nodePoints: THREE.Vector3[] = [];
  const nodeColors: THREE.Color[] = [];
  const nodeSizes: number[] = [];
  services.forEach((service, index) => {
    const dir = service.position.clone().normalize();
    const nearAnchor = dir.clone().multiplyScalar(5.14);
    connections.push(nearAnchor.x, nearAnchor.y, nearAnchor.z, service.position.x, service.position.y, service.position.z);
    if (index % 2 === 0) {
      const innerDir = dir.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), 0.27);
      const innerAnchor = innerDir.multiplyScalar(3.65);
      connections.push(innerAnchor.x, innerAnchor.y, innerAnchor.z, service.position.x, service.position.y, service.position.z);
    }
    nodePoints.push(service.position);
    nodeColors.push(service.hot ? BRIGHT : GOLD);
    nodeSizes.push(service.hot ? 4.5 : 2.3);
    addCircle(service.position, service.hot ? 0.3 : 0.23, Boolean(service.hot));

    const label = document.createElement('div');
    label.className = 'network-label';
    label.innerHTML = `<strong>${service.name}</strong><span>${service.detail}</span>`;
    const labelObject = new CSS2DObject(label);
    labelObject.position.copy(service.position).add(new THREE.Vector3((Math.sign(service.position.x) || 1) * 0.36, service.position.y > 3.5 ? 0.22 : -0.15, 0));
    nodesGroup.add(labelObject);
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(connections, 3));
  nodesGroup.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
    color: GOLD, transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending
  })));
  addPointCloud(nodePoints, nodeColors, nodeSizes, 1.45, 1, nodesGroup);
}

interface DataFlow {
  curve: THREE.QuadraticBezierCurve3;
  trace: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  speed: number;
  phase: number;
}

interface DataPacket {
  flow: DataFlow;
  offset: number;
  speed: number;
  position: THREE.Vector3;
}

const dataFlows: DataFlow[] = [];
const dataPackets: DataPacket[] = [];
let pulsePositionAttribute: THREE.BufferAttribute | null = null;

function createDataFlow(start: THREE.Vector3, end: THREE.Vector3, index: number, bright = false) {
  // To make it completely 3D, we bulge the curve outward from the center (0,0,0)
  const midpoint = start.clone().lerp(end, 0.5);
  const bulge = midpoint.clone().normalize().multiplyScalar(2.0 + (index % 4) * 0.5);
  midpoint.add(bulge);

  const curve = new THREE.QuadraticBezierCurve3(start, midpoint, end);
  const trace = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(curve.getPoints(80)),
    new THREE.LineBasicMaterial({
      color: bright ? BRIGHT : GOLD,
      transparent: true,
      opacity: bright ? 0.25 : 0.11,
      blending: THREE.AdditiveBlending
    })
  );
  nodesGroup.add(trace);
  const flow: DataFlow = {
    curve,
    trace,
    speed: 0.075 + (index % 5) * 0.014,
    phase: Math.random()
  };
  dataFlows.push(flow);
}

function addDataFlows() {
  const coreTargets = [0, 1, 3, 5, 8, 10, 11, 12, 14, 16, 17];
  coreTargets.forEach((serviceIndex, index) => {
    // Distribute start points on a small 3D sphere instead of a 2D circle
    const phi = Math.acos(-1 + (2 * index) / coreTargets.length);
    const theta = Math.sqrt(coreTargets.length * Math.PI) * phi;
    const start = new THREE.Vector3(
      0.42 * Math.cos(theta) * Math.sin(phi),
      0.42 * Math.sin(theta) * Math.sin(phi),
      0.42 * Math.cos(phi)
    );
    createDataFlow(start, services[serviceIndex].position, index, Boolean(services[serviceIndex].hot));
  });

  const crossServiceRoutes: Array<[number, number]> = [
    [0, 3], [1, 8], [2, 10], [3, 6], [4, 5], [5, 11],
    [8, 9], [9, 10], [10, 11], [11, 12], [12, 13], [13, 14],
    [15, 16], [16, 17], [17, 1]
  ];
  crossServiceRoutes.forEach(([from, to], index) => {
    createDataFlow(services[from].position, services[to].position, coreTargets.length + index, services[to].hot);
  });

  const positions = new Float32Array(dataFlows.length * 3 * 3);
  const colors = new Float32Array(dataFlows.length * 3 * 3);
  const sizes = new Float32Array(dataFlows.length * 3);
  const phases = new Float32Array(dataFlows.length * 3);

  dataFlows.forEach((flow, flowIndex) => {
    for (let tail = 0; tail < 3; tail++) {
      const packetIndex = flowIndex * 3 + tail;
      dataPackets.push({
        flow,
        offset: tail / 3 + Math.random() * 0.08,
        speed: 0.78 + Math.random() * 0.48,
        position: new THREE.Vector3()
      });
      const color = tail === 0 ? BRIGHT : GOLD.clone().lerp(BRIGHT, 0.45);
      colors.set([color.r, color.g, color.b], packetIndex * 3);
      sizes[packetIndex] = tail === 0 ? 1.0 : 0.52 - tail * 0.1;
      phases[packetIndex] = Math.random() * TAU;
    }
  });

  const geometry = new THREE.BufferGeometry();
  pulsePositionAttribute = new THREE.BufferAttribute(positions, 3);
  geometry.setAttribute('position', pulsePositionAttribute);
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  nodesGroup.add(new THREE.Points(geometry, makePointMaterial(1.65, 1)));
}

interface MajorPulse {
  flow: DataFlow;
  offset: number;
  speed: number;
  trailLength: number;
}

const majorPulses: MajorPulse[] = [];
const MAJOR_TRAIL_SEGMENTS = 14;
const UP = new THREE.Vector3(0, 1, 0);
const trailStart = new THREE.Vector3();
const trailEnd = new THREE.Vector3();
const trailMidpoint = new THREE.Vector3();
const trailDirection = new THREE.Vector3();
const trailScale = new THREE.Vector3(1, 1, 1);
const trailRotation = new THREE.Quaternion();
const trailMatrix = new THREE.Matrix4();
const hiddenTrailMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
const trailColor = new THREE.Color();
let majorTrailMesh: THREE.InstancedMesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial> | null = null;
let majorTrailHaloMesh: THREE.InstancedMesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial> | null = null;
let majorHeadPositionAttribute: THREE.BufferAttribute | null = null;

function addMajorPulseTrails() {
  // A curated subset keeps the energetic routes legible while still making the network feel alive.
  const routeIndices = [0, 2, 3, 5, 7, 9, 10, 12, 14, 16, 18, 20, 22, 25];
  const cylinder = new THREE.CylinderGeometry(0.07, 0.042, 1, 6, 1, true);
  const haloCylinder = new THREE.CylinderGeometry(0.135, 0.08, 1, 6, 1, true);
  const trailMaterial = new THREE.MeshBasicMaterial({
    color: BRIGHT,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  majorTrailMesh = new THREE.InstancedMesh(cylinder, trailMaterial, routeIndices.length * MAJOR_TRAIL_SEGMENTS);
  majorTrailMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  majorTrailMesh.frustumCulled = false;
  nodesGroup.add(majorTrailMesh);
  majorTrailHaloMesh = new THREE.InstancedMesh(
    haloCylinder,
    new THREE.MeshBasicMaterial({
      color: GOLD,
      vertexColors: true,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    }),
    routeIndices.length * MAJOR_TRAIL_SEGMENTS
  );
  majorTrailHaloMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  majorTrailHaloMesh.frustumCulled = false;
  nodesGroup.add(majorTrailHaloMesh);

  const headPositions = new Float32Array(routeIndices.length * 3);
  const headColors = new Float32Array(routeIndices.length * 3);
  const headSizes = new Float32Array(routeIndices.length);
  const headPhases = new Float32Array(routeIndices.length);

  routeIndices.forEach((routeIndex, index) => {
    const flow = dataFlows[routeIndex];
    majorPulses.push({
      flow,
      offset: index / routeIndices.length + Math.random() * 0.08,
      speed: 1.8 + (index % 4) * 0.22,
      trailLength: 0.34 + (index % 3) * 0.06
    });
    headColors.set([BRIGHT.r, BRIGHT.g, BRIGHT.b], index * 3);
    headSizes[index] = 0.98;
    headPhases[index] = Math.random() * TAU;
  });

  const headGeometry = new THREE.BufferGeometry();
  majorHeadPositionAttribute = new THREE.BufferAttribute(headPositions, 3);
  headGeometry.setAttribute('position', majorHeadPositionAttribute);
  headGeometry.setAttribute('aColor', new THREE.BufferAttribute(headColors, 3));
  headGeometry.setAttribute('aSize', new THREE.BufferAttribute(headSizes, 1));
  headGeometry.setAttribute('aPhase', new THREE.BufferAttribute(headPhases, 1));
  nodesGroup.add(new THREE.Points(headGeometry, makePointMaterial(2.2, 1)));

  for (let index = 0; index < routeIndices.length * MAJOR_TRAIL_SEGMENTS; index++) {
    majorTrailMesh.setMatrixAt(index, hiddenTrailMatrix);
    majorTrailHaloMesh.setMatrixAt(index, hiddenTrailMatrix);
  }
  majorTrailMesh.instanceMatrix.needsUpdate = true;
  majorTrailHaloMesh.instanceMatrix.needsUpdate = true;
}

function updateMajorPulseTrails(elapsed: number) {
  if (!majorTrailMesh || !majorTrailHaloMesh || !majorHeadPositionAttribute) return;

  let instanceIndex = 0;
  majorPulses.forEach((pulse, pulseIndex) => {
    const progress = (elapsed * pulse.flow.speed * pulse.speed + pulse.offset) % 1;
    const tailStartProgress = Math.max(0, progress - pulse.trailLength);
    const trailSpan = progress - tailStartProgress;

    pulse.flow.curve.getPointAt(progress, trailEnd);
    majorHeadPositionAttribute!.setXYZ(pulseIndex, trailEnd.x, trailEnd.y, trailEnd.z);

    for (let segment = 0; segment < MAJOR_TRAIL_SEGMENTS; segment++, instanceIndex++) {
      const startProgress = tailStartProgress + trailSpan * segment / MAJOR_TRAIL_SEGMENTS;
      const endProgress = tailStartProgress + trailSpan * (segment + 1) / MAJOR_TRAIL_SEGMENTS;
      pulse.flow.curve.getPointAt(startProgress, trailStart);
      pulse.flow.curve.getPointAt(endProgress, trailEnd);
      trailDirection.subVectors(trailEnd, trailStart);
      const length = trailDirection.length();

      if (length < 0.001) {
        majorTrailMesh!.setMatrixAt(instanceIndex, hiddenTrailMatrix);
        majorTrailHaloMesh!.setMatrixAt(instanceIndex, hiddenTrailMatrix);
        continue;
      }

      trailMidpoint.addVectors(trailStart, trailEnd).multiplyScalar(0.5);
      trailRotation.setFromUnitVectors(UP, trailDirection.normalize());
      trailScale.set(1, length * 1.18, 1);
      trailMatrix.compose(trailMidpoint, trailRotation, trailScale);
      majorTrailMesh!.setMatrixAt(instanceIndex, trailMatrix);
      majorTrailHaloMesh!.setMatrixAt(instanceIndex, trailMatrix);

      const headStrength = (segment + 1) / MAJOR_TRAIL_SEGMENTS;
      trailColor.copy(GOLD).lerp(BRIGHT, 0.55 + headStrength * 0.45);
      majorTrailMesh!.setColorAt(instanceIndex, trailColor);
      majorTrailHaloMesh!.setColorAt(instanceIndex, trailColor);
    }
  });

  majorTrailMesh.instanceMatrix.needsUpdate = true;
  majorTrailHaloMesh.instanceMatrix.needsUpdate = true;
  if (majorTrailMesh.instanceColor) majorTrailMesh.instanceColor.needsUpdate = true;
  if (majorTrailHaloMesh.instanceColor) majorTrailHaloMesh.instanceColor.needsUpdate = true;
  majorHeadPositionAttribute.needsUpdate = true;
}

const backgroundDust = addBackgroundDust() as THREE.Points;
backgroundDust.visible = false;

addServiceNetwork();
addDataFlows();
addMajorPulseTrails();

window.addEventListener('click', () => {
  if (sphereState === 'compressed' || sphereState === 'compressing') {
    sphereState = 'expanding';
    backgroundDust.visible = true;
    sphereShells.forEach(shell => shell.visible = true);
    if (startLabel) startLabel.classList.add('hidden');
  } else if (sphereState === 'expanded' || sphereState === 'expanding') {
    sphereState = 'compressing';
    nodesState = 'compressing';
    backgroundDust.visible = false;
    if (startLabel) startLabel.classList.remove('hidden');
  }
});

function connectWebSocket() {
  const ws = new WebSocket('ws://localhost:8080');
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'STATE_CHANGE' && nodesState === 'hidden' && (sphereState === 'expanded' || sphereState === 'expanding')) {
        nodesGroup.visible = true;
        nodesState = 'expanding';
      }
    } catch (e) {}
  };
  ws.onclose = () => {
    setTimeout(connectWebSocket, 2000);
  };
}
connectWebSocket();

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const elapsed = clock.getElapsedTime();

  if (sphereState === 'expanding') {
    let allExpanded = true;
    sphereShells.forEach(shell => {
      shell.scale.lerp(new THREE.Vector3(1, 1, 1), 0.03);
      const mat = shell.material as THREE.ShaderMaterial;
      mat.uniforms.opacity.value = THREE.MathUtils.lerp(mat.uniforms.opacity.value, shell.userData.baseOpacity, 0.04);
      if (shell.scale.x < 0.99) allExpanded = false;
    });
    if (allExpanded) {
      sphereState = 'expanded';
    }
  } else if (sphereState === 'expanded') {
    sphereShells.forEach((shell, index) => {
      const breathe = 1.0 + Math.sin(elapsed * 2.0 + index * 1.5) * 0.012;
      shell.scale.set(breathe, breathe, breathe);
      
      const mat = shell.material as THREE.ShaderMaterial;
      mat.uniforms.opacity.value = shell.userData.baseOpacity + Math.sin(elapsed * 3.0 + index) * 0.15;
    });
  } else if (sphereState === 'compressing') {
    let allCompressed = true;
    sphereShells.forEach(shell => {
      shell.scale.lerp(new THREE.Vector3(0.001, 0.001, 0.001), 0.04);
      const mat = shell.material as THREE.ShaderMaterial;
      mat.uniforms.opacity.value = THREE.MathUtils.lerp(mat.uniforms.opacity.value, 0, 0.08);
      if (shell.scale.x > 0.01) allCompressed = false;
    });
    if (allCompressed) {
      sphereState = 'compressed';
      sphereShells.forEach(shell => {
        shell.scale.set(0.001, 0.001, 0.001);
        shell.visible = false;
      });
    }
  }

  if (nodesState === 'expanding') {
    labelContainer.style.display = 'block';
    nodesGroup.scale.lerp(new THREE.Vector3(1, 1, 1), 0.02);
    if (nodesGroup.scale.x > 0.99) {
      nodesState = 'expanded';
      nodesGroup.scale.set(1, 1, 1);
    }
  } else if (nodesState === 'compressing') {
    nodesGroup.scale.lerp(new THREE.Vector3(0.001, 0.001, 0.001), 0.05);
    if (nodesGroup.scale.x < 0.01) {
      nodesState = 'hidden';
      nodesGroup.scale.set(0.001, 0.001, 0.001);
      nodesGroup.visible = false;
      labelContainer.style.display = 'none';
    }
  }

  controls.update();
  globe.rotation.y = Math.sin(elapsed * 0.11) * 0.045;
  globe.rotation.z = Math.sin(elapsed * 0.08) * 0.012;
  dataFlows.forEach((flow, index) => {
    flow.trace.material.opacity = 0.08 + (Math.sin(elapsed * 1.65 + flow.phase + index) + 1) * 0.09;
  });
  updateMajorPulseTrails(elapsed);
  if (pulsePositionAttribute) {
    dataPackets.forEach((packet, index) => {
      const progress = (elapsed * packet.flow.speed * packet.speed + packet.offset) % 1;
      packet.flow.curve.getPointAt(progress, packet.position);
      pulsePositionAttribute!.setXYZ(index, packet.position.x, packet.position.y, packet.position.z);
    });
    pulsePositionAttribute.needsUpdate = true;
  }
  materialAnimations.forEach(material => { material.uniforms.time.value = elapsed; });
  composer.render();
  labelRenderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});
