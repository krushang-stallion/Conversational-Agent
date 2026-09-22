import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { AgentWSClient, AIState, ProjectData } from './wsClient.js';
import { AudioRecorder } from './audioRecorder.js';

// --- COLOR PALETTE & CONFIGURATION ---
const GOLD = new THREE.Color('#d9b84e');
const BRIGHT = new THREE.Color('#fff3a1');
const CYAN = new THREE.Color('#00e5ff');
const TAU = Math.PI * 2;

// --- DOM ELEMENTS ---
const canvasContainer = document.querySelector<HTMLElement>('#canvas-container')!;
const labelContainer = document.querySelector<HTMLElement>('#label-container')!;
const startLabel = document.querySelector<HTMLElement>('#start-label')!;
const statusPill = document.querySelector<HTMLElement>('#status-pill')!;
const statusText = document.querySelector<HTMLElement>('#status-text')!;
const subtitleCard = document.querySelector<HTMLElement>('#subtitle-card')!;
const subtitleText = document.querySelector<HTMLElement>('#subtitle-text')!;
const speakerBadge = document.querySelector<HTMLElement>('#speaker-badge')!;
const meterBars = document.querySelectorAll<HTMLElement>('.meter-bar');
const historyDrawer = document.querySelector<HTMLElement>('#history-drawer')!;
const historyToggleBtn = document.querySelector<HTMLElement>('#history-toggle-btn')!;
const historyCloseBtn = document.querySelector<HTMLElement>('#history-close-btn')!;
const drawerBody = document.querySelector<HTMLElement>('#drawer-body')!;
const muteToggleBtn = document.querySelector<HTMLElement>('#mute-toggle-btn')!;
const micOnIcon = document.querySelector<HTMLElement>('#mic-on-icon')!;
const micOffIcon = document.querySelector<HTMLElement>('#mic-off-icon')!;
const muteBtnText = document.querySelector<HTMLElement>('#mute-btn-text')!;
let isUserMuted = false;

// --- THREE.JS SCENE SETUP ---
const scene = new THREE.Scene();
scene.background = new THREE.Color('#070806');
scene.fog = new THREE.FogExp2('#070806', 0.023);

let sphereState: 'compressed' | 'expanding' | 'expanded' | 'compressing' = 'compressed';
let nodesState: 'hidden' | 'expanding' | 'expanded' | 'compressing' = 'hidden';
let currentAiState: AIState = 'idle';
let currentAudioLevel = 0.0;
let targetGlowColor = GOLD.clone();
let currentGlowColor = GOLD.clone();

labelContainer.style.display = 'none';
const sphereShells: THREE.Points[] = [];
const nodesGroup = new THREE.Group();
nodesGroup.scale.set(0.001, 0.001, 0.001);
nodesGroup.visible = false;
scene.add(nodesGroup);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0.15, 23.8);

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
controls.minDistance = 18;
controls.maxDistance = 30;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.18;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1.25, 0.55, 0.3);
composer.addPass(bloomPass);

const materialAnimations: THREE.ShaderMaterial[] = [];
const globe = new THREE.Group();
globe.rotation.x = -0.025;
scene.add(globe);

// --- SHADERS ---
function makePointMaterial(scale: number, opacity: number, allowAudioVibration = true) {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      time: { value: 0 },
      scale: { value: scale },
      opacity: { value: opacity },
      audioLevel: { value: 0 },
      allowVibration: { value: allowAudioVibration ? 1.0 : 0.0 },
      colorTint: { value: GOLD.clone() }
    },
    vertexShader: `
      attribute float aSize;
      attribute float aPhase;
      attribute vec3 aColor;
      uniform float time;
      uniform float scale;
      uniform float audioLevel;
      uniform float allowVibration;
      uniform vec3 colorTint;
      varying vec3 vColor;
      varying float vPulse;

      void main() {
        vec3 displacedPos = position + normalize(position) * (audioLevel * 0.08 * sin(time * 3.5 + aPhase * 2.0) * allowVibration);
        vec4 viewPosition = modelViewMatrix * vec4(displacedPos, 1.0);
        vPulse = 0.78 + sin(time * 1.3 + aPhase) * 0.22 + (audioLevel * 0.15 * allowVibration);
        vColor = mix(aColor, colorTint, 0.45) * vPulse;
        gl_PointSize = (aSize + audioLevel * 0.2 * allowVibration) * scale * (180.0 / -viewPosition.z);
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
  parent: THREE.Object3D = globe,
  allowAudioVibration = true
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

  const cloud = new THREE.Points(geometry, makePointMaterial(scale, opacity, allowAudioVibration));
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

function addCore() {
  const points: THREE.Vector3[] = [];
  const colors: THREE.Color[] = [];
  const sizes: number[] = [];

  for (let index = 0; index < 880; index++) {
    const u = Math.random();
    const v = Math.random();
    const theta = u * TAU;
    const phi = Math.acos(2.0 * v - 1.0);
    const r = Math.cbrt(Math.random()) * 0.65;

    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.sin(phi) * Math.sin(theta);
    const z = r * Math.cos(phi);

    points.push(new THREE.Vector3(x, y, z));
    colors.push(GOLD.clone().lerp(BRIGHT, 0.4 + Math.random() * 0.55));
    sizes.push(0.3 + Math.random() * 0.38);
  }
  addPointCloud(points, colors, sizes, 1.05, 1);
}

// Create the 3 Concentric Sphere Shells (Stage 1 Expansion)
addSphereShell(5.56, 59, 118, 0.9);
addSphereShell(3.74, 53, 106, 0.97);
addSphereShell(2.2, 44, 96, 0.94);
addCore();

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

const backgroundDust = addBackgroundDust() as THREE.Points;
backgroundDust.visible = false;

// --- DYNAMIC PROJECT NODES & 2ND EXPANSION BUILDER ---
// --- DYNAMIC PROJECT NODES & 2ND EXPANSION BUILDER ---
interface ServiceNode {
  name: string;
  detail: string;
  position: THREE.Vector3;
  hot?: boolean;
}

interface ProjectVisualNode {
  name: string;
  detail: string;
  position: THREE.Vector3;
  circleMesh: THREE.Line;
  labelElement: HTMLElement;
  hot?: boolean;
}

const nodeLabelElements = new Map<string, HTMLElement>();
let activeProjectNodes: ServiceNode[] = [];
const projectVisualNodes: ProjectVisualNode[] = [];

// Dedicated Active Project Comet Trail & Persistent Glowing 3D Tube Path Effect
const ACTIVE_COMET_SEGMENTS = 26;
let activeCometTargetPos: THREE.Vector3 | null = null;
let activeCometOpacity = 0;

let cometHeadMesh: THREE.Points | null = null;
let cometTrailMesh: THREE.InstancedMesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial> | null = null;
let cometTrailHaloMesh: THREE.InstancedMesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial> | null = null;
let cometHeadPosAttr: THREE.BufferAttribute | null = null;

// Volumetric 3D Tube Path Meshes for THICK Beam
let activePathTubeMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;
let activePathHaloMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;

function initActiveCometTrail() {
  const cylinder = new THREE.CylinderGeometry(0.06, 0.02, 1, 6, 1, true);
  const haloCylinder = new THREE.CylinderGeometry(0.12, 0.04, 1, 6, 1, true);

  const neonGreen = new THREE.Color('#00ff88');
  const neonCyan = new THREE.Color('#00ffc8');

  const trailMaterial = new THREE.MeshBasicMaterial({
    color: neonGreen,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  cometTrailMesh = new THREE.InstancedMesh(cylinder, trailMaterial, ACTIVE_COMET_SEGMENTS);
  cometTrailMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  cometTrailMesh.frustumCulled = false;
  nodesGroup.add(cometTrailMesh);

  cometTrailHaloMesh = new THREE.InstancedMesh(
    haloCylinder,
    new THREE.MeshBasicMaterial({
      color: neonCyan,
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    }),
    ACTIVE_COMET_SEGMENTS
  );
  cometTrailHaloMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  cometTrailHaloMesh.frustumCulled = false;
  nodesGroup.add(cometTrailHaloMesh);

  // Particle Head
  const headPos = new Float32Array(3);
  const headColor = new Float32Array([0, 1, 0.53]); // #00ff88
  const headSize = new Float32Array([1.5]);
  const headPhase = new Float32Array([0]);

  const geo = new THREE.BufferGeometry();
  cometHeadPosAttr = new THREE.BufferAttribute(headPos, 3);
  geo.setAttribute('position', cometHeadPosAttr);
  geo.setAttribute('aColor', new THREE.BufferAttribute(headColor, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(headSize, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(headPhase, 1));

  cometHeadMesh = new THREE.Points(geo, makePointMaterial(2.2, 1, false));
  nodesGroup.add(cometHeadMesh);

  // Initial Sleek Laser Tube for path (reduced width)
  const initCurve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, 3),
    new THREE.Vector3(0, 0, 6)
  );

  activePathTubeMesh = new THREE.Mesh(
    new THREE.TubeGeometry(initCurve, 30, 0.035, 8, false),
    new THREE.MeshBasicMaterial({
      color: neonGreen,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  nodesGroup.add(activePathTubeMesh);

  activePathHaloMesh = new THREE.Mesh(
    new THREE.TubeGeometry(initCurve, 30, 0.08, 8, false),
    new THREE.MeshBasicMaterial({
      color: neonCyan,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  nodesGroup.add(activePathHaloMesh);

  // Initialize all comet meshes as hidden by default
  cometHeadMesh.visible = false;
  activePathTubeMesh.visible = false;
  activePathHaloMesh.visible = false;
  cometTrailMesh.visible = false;
  cometTrailHaloMesh.visible = false;
  for (let i = 0; i < ACTIVE_COMET_SEGMENTS; i++) {
    cometTrailMesh.setMatrixAt(i, hiddenTrailMatrix);
    cometTrailHaloMesh.setMatrixAt(i, hiddenTrailMatrix);
  }
  cometTrailMesh.instanceMatrix.needsUpdate = true;
  cometTrailHaloMesh.instanceMatrix.needsUpdate = true;
  activeCometTargetPos = null;
  activeCometOpacity = 0;
}

function updateActiveCometTrail(elapsed: number) {
  if (!cometTrailMesh || !cometTrailHaloMesh || !cometHeadPosAttr || !cometHeadMesh || !activePathTubeMesh || !activePathHaloMesh) return;

  if (activeCometTargetPos) {
    activeCometOpacity = THREE.MathUtils.lerp(activeCometOpacity, 1.0, 0.15);
  } else {
    activeCometOpacity = THREE.MathUtils.lerp(activeCometOpacity, 0.0, 0.25);
  }

  if (activeCometOpacity < 0.01 || !activeCometTargetPos) {
    cometHeadMesh.visible = false;
    activePathTubeMesh.visible = false;
    activePathHaloMesh.visible = false;
    cometTrailMesh.visible = false;
    cometTrailHaloMesh.visible = false;
    for (let i = 0; i < ACTIVE_COMET_SEGMENTS; i++) {
      cometTrailMesh.setMatrixAt(i, hiddenTrailMatrix);
      cometTrailHaloMesh.setMatrixAt(i, hiddenTrailMatrix);
    }
    cometTrailMesh.instanceMatrix.needsUpdate = true;
    cometTrailHaloMesh.instanceMatrix.needsUpdate = true;
    return;
  }

  cometHeadMesh.visible = true;
  activePathTubeMesh.visible = true;
  activePathHaloMesh.visible = true;
  cometTrailMesh.visible = true;
  cometTrailHaloMesh.visible = true;

  const target = activeCometTargetPos || new THREE.Vector3(0, 0, 10);
  const dir = target.clone().normalize();
  const start = new THREE.Vector3(0, 0, 0);
  const mid = start.clone().lerp(target, 0.5);
  mid.add(dir.clone().cross(UP).normalize().multiplyScalar(0.75));
  const fullCurve = new THREE.QuadraticBezierCurve3(start, mid, target);

  const speed = 1.25;
  const progress = Math.max(0.03, (elapsed * speed) % 1.0);

  // Set particle head position
  fullCurve.getPointAt(progress, trailEnd);
  cometHeadPosAttr.setXYZ(0, trailEnd.x, trailEnd.y, trailEnd.z);
  cometHeadPosAttr.needsUpdate = true;

  // DYNAMIC SUB-CURVE: ONLY the path behind the moving particle grows and glows!
  const currentHeadPos = trailEnd.clone();
  const subStart = new THREE.Vector3(0, 0, 0);
  const subMid = subStart.clone().lerp(currentHeadPos, 0.5);
  subMid.add(dir.clone().cross(UP).normalize().multiplyScalar(0.75 * progress));
  const subCurve = new THREE.QuadraticBezierCurve3(subStart, subMid, currentHeadPos);

  const segments = Math.max(6, Math.floor(32 * progress));

  // Dynamically update laser tube geometry strictly along subCurve
  activePathTubeMesh.geometry.dispose();
  activePathHaloMesh.geometry.dispose();
  activePathTubeMesh.geometry = new THREE.TubeGeometry(subCurve, segments, 0.035, 8, false);
  activePathHaloMesh.geometry = new THREE.TubeGeometry(subCurve, segments, 0.08, 8, false);

  (activePathTubeMesh.material as THREE.MeshBasicMaterial).opacity = activeCometOpacity * 0.95;
  (activePathHaloMesh.material as THREE.MeshBasicMaterial).opacity = activeCometOpacity * 0.55;

  const tailStartProgress = 0.0;
  const trailSpan = Math.max(0.04, progress - tailStartProgress);

  const neonGreen = new THREE.Color('#00ff88');
  const neonCyan = new THREE.Color('#00ffc8');

  for (let segment = 0; segment < ACTIVE_COMET_SEGMENTS; segment++) {
    const sProgress = tailStartProgress + (trailSpan * segment) / ACTIVE_COMET_SEGMENTS;
    const eProgress = tailStartProgress + (trailSpan * (segment + 1)) / ACTIVE_COMET_SEGMENTS;

    fullCurve.getPointAt(sProgress, trailStart);
    fullCurve.getPointAt(eProgress, trailEnd);

    trailDirection.subVectors(trailEnd, trailStart);
    const length = trailDirection.length();

    if (length < 0.001) {
      cometTrailMesh.setMatrixAt(segment, hiddenTrailMatrix);
      cometTrailHaloMesh.setMatrixAt(segment, hiddenTrailMatrix);
      continue;
    }

    trailMidpoint.addVectors(trailStart, trailEnd).multiplyScalar(0.5);
    trailRotation.setFromUnitVectors(UP, trailDirection.normalize());
    const headStrength = (segment + 1) / ACTIVE_COMET_SEGMENTS;
    trailScale.set(0.9 + headStrength * 0.6, length * 1.15, 0.9 + headStrength * 0.6);

    trailMatrix.compose(trailMidpoint, trailRotation, trailScale);
    cometTrailMesh.setMatrixAt(segment, trailMatrix);
    cometTrailHaloMesh.setMatrixAt(segment, trailMatrix);

    trailColor.copy(neonCyan).lerp(neonGreen, headStrength);
    cometTrailMesh.setColorAt(segment, trailColor);
    cometTrailHaloMesh.setColorAt(segment, trailColor);
  }

  (cometTrailMesh.material as THREE.MeshBasicMaterial).opacity = activeCometOpacity;
  (cometTrailHaloMesh.material as THREE.MeshBasicMaterial).opacity = activeCometOpacity * 0.65;

  cometTrailMesh.instanceMatrix.needsUpdate = true;
  cometTrailHaloMesh.instanceMatrix.needsUpdate = true;
  if (cometTrailMesh.instanceColor) cometTrailMesh.instanceColor.needsUpdate = true;
  if (cometTrailHaloMesh.instanceColor) cometTrailHaloMesh.instanceColor.needsUpdate = true;
}

export function setProjectHighlight(nodeModuleName: string | null, active: boolean) {
  if (!nodeModuleName || !active) {
    activeCometTargetPos = null;
    activeCometOpacity = 0;
    projectVisualNodes.forEach((node) => {
      node.circleMesh.scale.set(1.0, 1.0, 1.0);
      (node.circleMesh.material as THREE.LineBasicMaterial).color.copy(node.hot ? BRIGHT : BRIGHT.clone().lerp(GOLD, 0.25));
      (node.circleMesh.material as THREE.LineBasicMaterial).opacity = node.hot ? 0.7 : 0.4;
      node.labelElement.classList.remove('node-highlight');
    });
    return;
  }

  const query = nodeModuleName.trim().toLowerCase();
  const STOP_WORDS = new Set(['project', 'projects', 'active', 'test', 'node', 'nodes', 'neural', 'sphere', 'app', 'service', 'services', 'check', 'execute', 'login', 'verified']);
  if (STOP_WORDS.has(query) || query.length < 2) {
    return;
  }

  let matchedNode: ProjectVisualNode | null = null;

  // 1. Exact match
  for (const node of projectVisualNodes) {
    if (node.name.toLowerCase() === query) {
      matchedNode = node;
      break;
    }
  }

  // 2. Word boundary match
  if (!matchedNode) {
    for (const node of projectVisualNodes) {
      const nameLower = node.name.toLowerCase();
      const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escapedQuery}\\b`, 'i');
      if (regex.test(nameLower) || (query.length >= 4 && nameLower.includes(query))) {
        matchedNode = node;
        break;
      }
    }
  }

  if (matchedNode) {
    activeCometTargetPos = matchedNode.position;
    projectVisualNodes.forEach((node) => {
      if (node === matchedNode) {
        node.circleMesh.scale.set(1.3, 1.3, 1.3);
        (node.circleMesh.material as THREE.LineBasicMaterial).color.set('#00ff88');
        (node.circleMesh.material as THREE.LineBasicMaterial).opacity = 1.0;
        node.labelElement.classList.add('node-highlight');
      } else {
        node.circleMesh.scale.set(1.0, 1.0, 1.0);
        (node.circleMesh.material as THREE.LineBasicMaterial).color.copy(node.hot ? BRIGHT : BRIGHT.clone().lerp(GOLD, 0.25));
        (node.circleMesh.material as THREE.LineBasicMaterial).opacity = node.hot ? 0.7 : 0.4;
        node.labelElement.classList.remove('node-highlight');
      }
    });
  }
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

function addCircle(position: THREE.Vector3, radius: number, hot: boolean) {
  const points: THREE.Vector3[] = [];
  const segments = 32;
  for (let index = 0; index <= segments; index++) {
    const angle = (index / segments) * TAU;
    points.push(new THREE.Vector3(position.x + Math.cos(angle) * radius, position.y + Math.sin(angle) * radius, position.z));
  }
  const circleMesh = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({
      color: hot ? BRIGHT : BRIGHT.clone().lerp(GOLD, 0.25), transparent: true, opacity: hot ? 0.7 : 0.4, blending: THREE.AdditiveBlending
    })
  );
  nodesGroup.add(circleMesh);
  return circleMesh;
}

function createDataFlow(start: THREE.Vector3, end: THREE.Vector3, index: number, bright = false) {
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

export function buildDynamicProjectNetwork(projectList: ProjectData[]) {
  // Clear old dynamic nodes if any
  while (nodesGroup.children.length > 0) {
    const obj = nodesGroup.children[0];
    nodesGroup.remove(obj);
  }
  nodeLabelElements.clear();
  projectVisualNodes.length = 0;
  dataFlows.length = 0;
  dataPackets.length = 0;
  majorPulses.length = 0;

  const count = projectList.length;
  if (count === 0) return;

  activeProjectNodes = projectList.map((p, index) => {
    const R = 6.8;
    let pos: THREE.Vector3;

    if (count === 1) {
      pos = new THREE.Vector3(0, 1.2, R);
    } else if (count === 2) {
      const x = index === 0 ? -5.4 : 5.4;
      pos = new THREE.Vector3(x, 1.0, 4.8);
    } else {
      // Golden Spiral / Fibonacci sphere distribution for exact N points
      const phi = Math.acos(-1 + (2 * (index + 0.5)) / count);
      const theta = Math.sqrt(count * Math.PI) * phi;
      pos = new THREE.Vector3(
        R * Math.cos(theta) * Math.sin(phi),
        R * Math.sin(theta) * Math.sin(phi),
        R * Math.cos(phi)
      );
    }

    return {
      name: p.name,
      detail: p.detail || `PROJECT / ${p.id}`,
      position: pos,
      hot: Boolean(p.hot)
    };
  });

  const connections: number[] = [];
  const nodePoints: THREE.Vector3[] = [];
  const nodeColors: THREE.Color[] = [];
  const nodeSizes: number[] = [];

  activeProjectNodes.forEach((project, index) => {
    const dir = project.position.clone().normalize();
    const nearAnchor = dir.clone().multiplyScalar(3.65);
    connections.push(nearAnchor.x, nearAnchor.y, nearAnchor.z, project.position.x, project.position.y, project.position.z);

    if (index % 2 === 0) {
      const innerDir = dir.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), 0.27);
      const innerAnchor = innerDir.multiplyScalar(2.8);
      connections.push(innerAnchor.x, innerAnchor.y, innerAnchor.z, project.position.x, project.position.y, project.position.z);
    }

    nodePoints.push(project.position);
    nodeColors.push(project.hot ? BRIGHT : BRIGHT.clone().lerp(GOLD, 0.2));
    nodeSizes.push(project.hot ? 0.55 : 0.35);
    const circleMesh = addCircle(project.position, project.hot ? 0.11 : 0.08, Boolean(project.hot));

    // CSS2D Floating Label with Real Project Name (only project name)
    const label = document.createElement('div');
    label.className = 'network-label';
    label.innerHTML = `<strong>${project.name}</strong>`;
    nodeLabelElements.set(project.name.toLowerCase(), label);
    nodeLabelElements.set(project.detail.toLowerCase(), label);

    const labelObject = new CSS2DObject(label);
    labelObject.position.copy(project.position).add(
      new THREE.Vector3((Math.sign(project.position.x) || 1) * 0.36, project.position.y > 3.5 ? 0.22 : -0.15, 0)
    );
    nodesGroup.add(labelObject);

    projectVisualNodes.push({
      name: project.name,
      detail: project.detail,
      position: project.position,
      circleMesh,
      labelElement: label,
      hot: Boolean(project.hot)
    });
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(connections, 3));
  nodesGroup.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
    color: BRIGHT.clone().lerp(GOLD, 0.4), transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending
  })));
  addPointCloud(nodePoints, nodeColors, nodeSizes, 0.7, 0.85, nodesGroup, false);

  // Data Flows
  activeProjectNodes.forEach((project, index) => {
    const phi = Math.acos(-1 + (2 * index) / activeProjectNodes.length);
    const theta = Math.sqrt(activeProjectNodes.length * Math.PI) * phi;
    const start = new THREE.Vector3(
      0.42 * Math.cos(theta) * Math.sin(phi),
      0.42 * Math.sin(theta) * Math.sin(phi),
      0.42 * Math.cos(phi)
    );
    createDataFlow(start, project.position, index, Boolean(project.hot));

    if (index > 0) {
      createDataFlow(activeProjectNodes[index - 1].position, project.position, activeProjectNodes.length + index, project.hot);
    }
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

  const flowGeo = new THREE.BufferGeometry();
  pulsePositionAttribute = new THREE.BufferAttribute(positions, 3);
  flowGeo.setAttribute('position', pulsePositionAttribute);
  flowGeo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  flowGeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  flowGeo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  nodesGroup.add(new THREE.Points(flowGeo, makePointMaterial(1.65, 1, false)));

  // Major Pulse Trails
  const trailCount = Math.min(dataFlows.length, 12);
  const cylinder = new THREE.CylinderGeometry(0.07, 0.042, 1, 6, 1, true);
  const haloCylinder = new THREE.CylinderGeometry(0.135, 0.08, 1, 6, 1, true);
  const trailMaterial = new THREE.MeshBasicMaterial({
    color: BRIGHT, vertexColors: true, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending
  });

  majorTrailMesh = new THREE.InstancedMesh(cylinder, trailMaterial, trailCount * MAJOR_TRAIL_SEGMENTS);
  majorTrailMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  majorTrailMesh.frustumCulled = false;
  nodesGroup.add(majorTrailMesh);

  majorTrailHaloMesh = new THREE.InstancedMesh(
    haloCylinder,
    new THREE.MeshBasicMaterial({
      color: GOLD, vertexColors: true, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending
    }),
    trailCount * MAJOR_TRAIL_SEGMENTS
  );
  majorTrailHaloMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  majorTrailHaloMesh.frustumCulled = false;
  nodesGroup.add(majorTrailHaloMesh);

  const headPositions = new Float32Array(trailCount * 3);
  const headColors = new Float32Array(trailCount * 3);
  const headSizes = new Float32Array(trailCount);
  const headPhases = new Float32Array(trailCount);

  for (let index = 0; index < trailCount; index++) {
    const flow = dataFlows[index];
    majorPulses.push({
      flow,
      offset: index / trailCount + Math.random() * 0.08,
      speed: 1.8 + (index % 4) * 0.22,
      trailLength: 0.34 + (index % 3) * 0.06
    });
    headColors.set([BRIGHT.r, BRIGHT.g, BRIGHT.b], index * 3);
    headSizes[index] = 0.98;
    headPhases[index] = Math.random() * TAU;
  }

  const headGeometry = new THREE.BufferGeometry();
  majorHeadPositionAttribute = new THREE.BufferAttribute(headPositions, 3);
  headGeometry.setAttribute('position', majorHeadPositionAttribute);
  headGeometry.setAttribute('aColor', new THREE.BufferAttribute(headColors, 3));
  headGeometry.setAttribute('aSize', new THREE.BufferAttribute(headSizes, 1));
  headGeometry.setAttribute('aPhase', new THREE.BufferAttribute(headPhases, 1));
  nodesGroup.add(new THREE.Points(headGeometry, makePointMaterial(2.2, 1, false)));

  // Initialize Dedicated Active Project Comet Trail
  initActiveCometTrail();

  // Trigger Stage 2 Bloom Expansion
  labelContainer.style.display = 'block';
  labelContainer.style.opacity = '1';
  nodesGroup.visible = true;
  nodesState = 'expanding';
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
      const startProgress = tailStartProgress + (trailSpan * segment) / MAJOR_TRAIL_SEGMENTS;
      const endProgress = tailStartProgress + (trailSpan * (segment + 1)) / MAJOR_TRAIL_SEGMENTS;
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

// --- CLIENT & AGENT INTEGRATION ---
const wsClient = new AgentWSClient();
const audioRecorder = new AudioRecorder();

function updateStatusUI(state: AIState) {
  currentAiState = state;
  if (isUserMuted && state === 'listening') {
    statusPill.className = 'status-pill muted';
    statusText.innerText = '● MIC MUTED';
    targetGlowColor.copy(GOLD);
    return;
  }
  statusPill.className = `status-pill ${state}`;

  switch (state) {
    case 'listening':
      statusText.innerText = '● LISTENING';
      targetGlowColor.copy(GOLD);
      break;
    case 'thinking':
      statusText.innerText = '● THINKING';
      targetGlowColor.copy(CYAN);
      break;
    case 'speaking':
      statusText.innerText = '● SPEAKING';
      targetGlowColor.copy(BRIGHT);
      break;
    case 'idle':
    default:
      statusText.innerText = 'SYSTEM DORMANT';
      targetGlowColor.copy(GOLD);
      break;
  }
}

function setMuteUI(muted: boolean) {
  isUserMuted = muted;
  audioRecorder.setMuted(muted);
  if (muted) {
    muteToggleBtn.classList.add('muted');
    micOnIcon.style.display = 'none';
    micOffIcon.style.display = 'inline-block';
    muteBtnText.innerText = 'UNMUTE';
    if (sphereState === 'expanded' && currentAiState !== 'speaking') {
      statusPill.className = 'status-pill muted';
      statusText.innerText = '● MIC MUTED';
      updateVoiceMeter(0);
    }
  } else {
    muteToggleBtn.classList.remove('muted');
    micOnIcon.style.display = 'inline-block';
    micOffIcon.style.display = 'none';
    muteBtnText.innerText = 'MUTE';
    if (sphereState === 'expanded' && currentAiState !== 'speaking') {
      updateStatusUI('listening');
    }
  }
}

muteToggleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (sphereState === 'compressed' || sphereState === 'compressing') return;
  setMuteUI(!isUserMuted);
});

function updateVoiceMeter(level: number) {
  currentAudioLevel = THREE.MathUtils.lerp(currentAudioLevel, level, 0.35);
  meterBars.forEach((bar, idx) => {
    const height = Math.max(3, Math.min(18, Math.sin(idx * 0.8 + performance.now() * 0.01) * 8 * currentAudioLevel + currentAudioLevel * 14));
    bar.style.height = `${height}px`;
  });
}

let speechMeterInterval: any = null;

function speakAgentText(text: string) {
  if (!('speechSynthesis' in window)) return;

  window.speechSynthesis.cancel();

  const cleanText = text.replace(/[*_#`~[\]()]/g, '').trim();
  if (!cleanText) return;

  const utterance = new SpeechSynthesisUtterance(cleanText);
  utterance.rate = 1.05;
  utterance.pitch = 1.0;

  const voices = window.speechSynthesis.getVoices();
  const naturalVoice = voices.find((v) =>
    v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Samantha') || v.lang.startsWith('en')
  );
  if (naturalVoice) {
    utterance.voice = naturalVoice;
  }

  audioRecorder.setMuted(true);

  utterance.onstart = () => {
    updateStatusUI('speaking');
    let t = 0;
    clearInterval(speechMeterInterval);
    speechMeterInterval = setInterval(() => {
      t += 0.2;
      const simLevel = 0.2 + Math.sin(t * 2.0) * 0.08 + Math.random() * 0.04;
      updateVoiceMeter(simLevel);
    }, 50);
  };

  const onFinish = () => {
    clearInterval(speechMeterInterval);
    updateVoiceMeter(0.0);
    audioRecorder.setMuted(false);
    if (sphereState === 'expanded') {
      updateStatusUI('listening');
    }
  };

  utterance.onend = onFinish;
  utterance.onerror = onFinish;

  window.speechSynthesis.speak(utterance);
}

let currentNaturalAudio: HTMLAudioElement | null = null;

function playNaturalAudio(base64Audio: string) {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  if (currentNaturalAudio) {
    currentNaturalAudio.pause();
  }

  audioRecorder.setMuted(true);
  updateStatusUI('speaking');

  currentNaturalAudio = new Audio(`data:audio/mp3;base64,${base64Audio}`);
  currentNaturalAudio.play().catch(console.warn);

  const onEnded = () => {
    updateVoiceMeter(0.0);
    audioRecorder.setMuted(false);
    if (sphereState === 'expanded') {
      updateStatusUI('listening');
    }
  };

  currentNaturalAudio.onended = onEnded;
  currentNaturalAudio.onerror = onEnded;
}

function displaySubtitle(speaker: 'user' | 'agent', text: string, isFinal: boolean) {
  subtitleCard.classList.add('active');
  speakerBadge.className = `speaker-badge ${speaker}`;
  speakerBadge.innerText = speaker === 'user' ? 'USER SPEECH' : 'NEURAL CORE';
  subtitleText.innerText = text;

  // Auto-detect project mentions in speech transcript
  let detectedProjectName: string | null = null;
  if (activeProjectNodes.length > 0) {
    const textLower = text.toLowerCase();
    const GENERIC_EXCLUDES = ['project', 'projects', 'active', 'test', 'node', 'nodes', 'neural', 'sphere', 'check', 'execute', 'login', 'verified'];
    for (const project of activeProjectNodes) {
      const pName = project.name.toLowerCase();
      if (GENERIC_EXCLUDES.includes(pName) || pName.length < 3) continue;
      if (textLower.includes(pName)) {
        detectedProjectName = project.name;
        break;
      }
    }
  }

  if (detectedProjectName) {
    setProjectHighlight(detectedProjectName, true);
  } else if (isFinal && speaker === 'agent') {
    // Hide laser trail when not conversing about a project
    setProjectHighlight(null, false);
  }

  if (isFinal) {
    appendTranscriptHistory(speaker, text);
    if (speaker === 'agent' && !currentNaturalAudio) {
      speakAgentText(text);
    }
  }
}

function appendTranscriptHistory(speaker: 'user' | 'agent', text: string) {
  const emptyNote = drawerBody.querySelector('div[style*="text-align: center"]');
  if (emptyNote) emptyNote.remove();

  const entry = document.createElement('div');
  entry.className = 'history-entry';
  entry.innerHTML = `
    <div class="history-role ${speaker}">${speaker === 'user' ? 'User' : 'Neural Core'}</div>
    <div class="history-content">${text}</div>
  `;
  drawerBody.appendChild(entry);
  drawerBody.scrollTop = drawerBody.scrollHeight;
}

// WebSocket Event Listeners
wsClient.connect({
  onStateChange: (state) => {
    updateStatusUI(state);
  },
  onNodeActive: (nodeModule) => {
    setProjectHighlight(nodeModule, true);
  },
  onNodeIdle: (nodeModule) => {
    setProjectHighlight(nodeModule, false);
  },
  onProjectsLoaded: (projects) => {
    console.log('🌟 Dynamic User Projects loaded:', projects);
    buildDynamicProjectNetwork(projects);
  },
  onTranscript: (speaker, text, isFinal) => {
    displaySubtitle(speaker, text, isFinal);
  },
  onAudioStream: (base64Audio) => {
    playNaturalAudio(base64Audio);
  }
});

// UI Drawer Toggle
historyToggleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  historyDrawer.classList.toggle('open');
});
historyCloseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  historyDrawer.classList.remove('open');
});
historyDrawer.addEventListener('click', (e) => {
  e.stopPropagation();
});

// --- JWT TOKEN EXTRACTION FROM URL ---
const urlParams = new URLSearchParams(window.location.search);
const userJwtToken = urlParams.get('token') || urlParams.get('jwt') || urlParams.get('bearer') || '';

// Wake-up Screen Click Handlers
window.addEventListener('click', () => {
  if (sphereState === 'compressed' || sphereState === 'compressing') {
    // CLICK #1: WAKE UP NEURAL SYSTEM (Stage 1 Expansion - Concentric Spheres Bloom)
    sphereState = 'expanding';
    nodesGroup.visible = false;
    labelContainer.style.display = 'none';
    labelContainer.style.opacity = '1';
    nodesState = 'hidden';
    backgroundDust.visible = true;
    sphereShells.forEach((shell) => (shell.visible = true));
    if (startLabel) startLabel.classList.add('hidden');

    // On wake up, microphone is unmuted by default
    setMuteUI(false);
    wsClient.startSession(userJwtToken);

    // Open VAD Microphone Session
    audioRecorder.start({
      onSpeechStart: () => {
        subtitleCard.classList.add('active');
        speakerBadge.className = 'speaker-badge user';
        speakerBadge.innerText = 'USER (LISTENING)';
      },
      onSpeechResult: (text, isFinal) => {
        displaySubtitle('user', text, isFinal);
        if (isFinal) {
          wsClient.sendUserSpeech(text);
        }
      },
      onAudioLevel: (level) => {
        updateVoiceMeter(level);
      }
    });
  } else if (sphereState === 'expanded' || sphereState === 'expanding') {
    // CLICK #2: STAGED TWO-PHASE COLLAPSE & END SESSION
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    clearInterval(speechMeterInterval);
    audioRecorder.stop();
    wsClient.endSession();
    updateStatusUI('idle');
    subtitleCard.classList.remove('active');
    setProjectHighlight(null, false);
    setMuteUI(false);

    if (nodesState === 'expanded' || nodesState === 'expanding') {
      // Phase 1: Collapse peripheral nodes first while holding concentric spheres open
      nodesState = 'compressing';
      labelContainer.style.opacity = '0';
    } else {
      // If nodes were not open, directly collapse spheres
      sphereState = 'compressing';
      nodesState = 'hidden';
      labelContainer.style.display = 'none';
    }
  }
});

// --- RENDER & ANIMATION LOOP ---
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const elapsed = clock.getElapsedTime();

  currentGlowColor.lerp(targetGlowColor, 0.05);
  materialAnimations.forEach((material) => {
    material.uniforms.time.value = elapsed;
    material.uniforms.colorTint.value = currentGlowColor;
    material.uniforms.audioLevel.value = currentAudioLevel;
  });

  // 1. Sphere Shell Expansion / Breathing / Compression (Phase 2 of Collapse)
  if (sphereState === 'expanding') {
    let allExpanded = true;
    sphereShells.forEach((shell) => {
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
      const audioMultiplier = currentAiState === 'speaking' ? currentAudioLevel * 0.04 : 0;
      const breathe = 1.0 + Math.sin(elapsed * 2.0 + index * 1.5) * 0.012 + audioMultiplier;
      shell.scale.set(breathe, breathe, breathe);

      const mat = shell.material as THREE.ShaderMaterial;
      mat.uniforms.opacity.value = shell.userData.baseOpacity + Math.sin(elapsed * 3.0 + index) * 0.15;
    });
  } else if (sphereState === 'compressing') {
    let allCompressed = true;
    sphereShells.forEach((shell) => {
      shell.scale.lerp(new THREE.Vector3(0.001, 0.001, 0.001), 0.038);
      const mat = shell.material as THREE.ShaderMaterial;
      mat.uniforms.opacity.value = THREE.MathUtils.lerp(mat.uniforms.opacity.value, 0, 0.06);
      if (shell.scale.x > 0.008) allCompressed = false;
    });
    if (allCompressed) {
      sphereState = 'compressed';
      sphereShells.forEach((shell) => {
        shell.scale.set(0.001, 0.001, 0.001);
        shell.visible = false;
      });
      backgroundDust.visible = false;
      if (startLabel) startLabel.classList.remove('hidden');
    }
  }

  // 2. Peripheral Service Nodes Expansion & Collapse (Phase 1 of Collapse)
  if (nodesState === 'expanding') {
    labelContainer.style.display = 'block';
    labelContainer.style.opacity = '1';
    nodesGroup.scale.lerp(new THREE.Vector3(1, 1, 1), 0.025);
    if (nodesGroup.scale.x > 0.99) {
      nodesState = 'expanded';
      nodesGroup.scale.set(1, 1, 1);
    }
  } else if (nodesState === 'compressing') {
    nodesGroup.scale.lerp(new THREE.Vector3(0.001, 0.001, 0.001), 0.045);
    if (nodesGroup.scale.x < 0.008) {
      nodesState = 'hidden';
      nodesGroup.scale.set(0.001, 0.001, 0.001);
      nodesGroup.visible = false;
      labelContainer.style.display = 'none';
      labelContainer.style.opacity = '1';
      // Phase 1 Completed: Nodes are fully absorbed -> Now trigger Phase 2 (Spheres Collapse)
      sphereState = 'compressing';
    }
  }

  controls.update();
  globe.rotation.y = Math.sin(elapsed * 0.11) * 0.045;
  globe.rotation.z = Math.sin(elapsed * 0.08) * 0.012;

  dataFlows.forEach((flow, index) => {
    flow.trace.material.opacity = 0.08 + (Math.sin(elapsed * 1.65 + flow.phase + index) + 1) * 0.09;
  });

  updateMajorPulseTrails(elapsed);
  updateActiveCometTrail(elapsed);

  if (pulsePositionAttribute) {
    dataPackets.forEach((packet, index) => {
      const progress = (elapsed * packet.flow.speed * packet.speed + packet.offset) % 1;
      packet.flow.curve.getPointAt(progress, packet.position);
      pulsePositionAttribute!.setXYZ(index, packet.position.x, packet.position.y, packet.position.z);
    });
    pulsePositionAttribute.needsUpdate = true;
  }

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
