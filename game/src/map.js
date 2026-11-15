// Kestrel Yard: an original container-port map. Three north-south lanes (west, mid, east)
// tied by cross corridors; the Depot warehouse is site A in the north-west, the Crane Pad
// is site B in the north-east. Breakers spawn at the south gate, Wardens at the north.
// This module owns the map data (colliders, sites, spawns, navigation graph, hold points)
// and builds every mesh of the scene.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { colliders, losClear } from './physics.js';

export function yawToward(fromX, fromZ, toX, toZ) {
  return Math.atan2(-(toX - fromX), -(toZ - fromZ));
}

export function dist2d(ax, az, bx, bz) {
  return Math.hypot(bx - ax, bz - az);
}

const SITES = [
  { id: 'A', name: 'Depot', x: -30, z: -16, r: 7 },
  { id: 'B', name: 'Crane Pad', x: 30, z: -16, r: 7 },
];

const SPAWNS = {
  0: [ // Breakers, south gate, facing north
    { x: -4, z: 29 }, { x: 0, z: 30 }, { x: 4, z: 29 }, { x: -8, z: 30 }, { x: 8, z: 30 },
  ],
  1: [ // Wardens, north side, facing south
    { x: -33, z: -29 }, { x: -27, z: -29 }, { x: 27, z: -29 }, { x: 33, z: -29 }, { x: 0, z: -30 },
  ],
};

const NAV_NODES = [
  [0, 29], [-8, 22], [8, 22], [-20, 20], [20, 20], [-20, 6], [20, 6], [-20, -6], [20, -6],
  [-26, -4], [26, -4], [-30, -16], [30, -16], [-34, -25], [34, -25], [0, 12], [0, -6],
  [0, -24], [-14, -27], [14, -27], [-40, 0], [40, 0], [-41, -16], [41, -16], [-8, -16],
  [8, -16], [-20, -20], [20, -20], [-14, 20], [14, 20],
];

// Where defenders (and, after a plant, attackers) hold: a spot plus what it watches.
const HOLDS = {
  A: [
    { x: -24, z: -10, lookX: -30, lookZ: -4 },
    { x: -36, z: -22, lookX: -24, lookZ: -14 },
    { x: -23.5, z: -20, lookX: -30, lookZ: -16 },
  ],
  B: [
    { x: 24, z: -10, lookX: 30, lookZ: -4 },
    { x: 36, z: -22, lookX: 26, lookZ: -14 },
    { x: 23.5, z: -20, lookX: 30, lookZ: -16 },
  ],
  MID: [{ x: -2, z: -22, lookX: 0, lookZ: -6 }, { x: 3, z: -10, lookX: 0, lookZ: 4 }],
};

const materials = new Map();
function material(color, rough = 0.88) {
  const key = `${color}/${rough}`;
  if (!materials.has(key)) {
    materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.04 }));
  }
  return materials.get(key);
}

const unitBox = new THREE.BoxGeometry(1, 1, 1);

function box(scene, x, y, z, sx, sy, sz, color, { collide = true, rough = 0.88, shadow = true } = {}) {
  const mesh = new THREE.Mesh(unitBox, material(color, rough));
  mesh.position.set(x, y + sy / 2, z);
  mesh.scale.set(sx, sy, sz);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  scene.add(mesh);
  if (collide) {
    colliders.push({
      minX: x - sx / 2, minY: y, minZ: z - sz / 2,
      maxX: x + sx / 2, maxY: y + sy, maxZ: z + sz / 2,
    });
  }
  return mesh;
}

function container(scene, cx, cz, alongZ, stacked, colorIndex) {
  const len = 12;
  const wid = 2.6;
  const h = 2.6;
  const levels = stacked ? 2 : 1;
  const color = PALETTE.containers[colorIndex % PALETTE.containers.length];
  const sx = alongZ ? wid : len;
  const sz = alongZ ? len : wid;
  for (let level = 0; level < levels; level += 1) {
    const shade = level === 0 ? color : PALETTE.containers[(colorIndex + 2) % PALETTE.containers.length];
    box(scene, cx, level * h, cz, sx, h, sz, shade, { collide: level === 0 });
    // Corner posts and a top rim give the box its corrugated, manufactured read.
    const px = sx / 2 - 0.09;
    const pz = sz / 2 - 0.09;
    for (const ox of [-px, px]) {
      for (const oz of [-pz, pz]) {
        box(scene, cx + ox, level * h, cz + oz, 0.18, h, 0.18, PALETTE.gunmetal, { collide: false });
      }
    }
    box(scene, cx, level * h + h - 0.14, cz, sx + 0.06, 0.14, sz + 0.06, PALETTE.gunmetal, { collide: false });
  }
  if (levels === 2) {
    colliders.push({
      minX: cx - sx / 2, minY: h, minZ: cz - sz / 2,
      maxX: cx + sx / 2, maxY: h * 2, maxZ: cz + sz / 2,
    });
  }
}

function letterTexture(letter, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  g.font = '900 190px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 14;
  g.strokeStyle = 'rgba(10,12,16,0.85)';
  g.strokeText(letter, 128, 138);
  g.fillStyle = color;
  g.fillText(letter, 128, 138);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

function groundTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const g = canvas.getContext('2d');
  g.fillStyle = '#3a3f45';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5200; i += 1) {
    const v = 46 + Math.floor(Math.random() * 26);
    g.fillStyle = `rgb(${v},${v + 3},${v + 7})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  g.strokeStyle = 'rgba(20,22,26,0.5)';
  g.lineWidth = 2;
  g.strokeRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(18, 14);
  tex.anisotropy = 4;
  return tex;
}

export function buildMap(scene) {
  colliders.length = 0;

  // --- light and sky -------------------------------------------------------
  scene.fog = new THREE.Fog(PALETTE.fog, 34, 130);
  const skyGeo = new THREE.SphereGeometry(240, 24, 14);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(PALETTE.sky) },
      low: { value: new THREE.Color(PALETTE.skyLow) },
    },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 low; varying vec3 vP; void main(){ float h = clamp(normalize(vP).y * 1.6, 0.0, 1.0); gl_FragColor = vec4(mix(low, top, pow(h, 0.7)), 1.0); }',
  });
  scene.add(new THREE.Mesh(skyGeo, skyMat));

  const hemi = new THREE.HemisphereLight(0x93aed6, 0x4a4238, 1.15);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(PALETTE.sun, 3.0);
  sun.position.set(-52, 34, -30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -62;
  sun.shadow.camera.right = 62;
  sun.shadow.camera.top = 48;
  sun.shadow.camera.bottom = -48;
  sun.shadow.camera.far = 180;
  sun.shadow.bias = -0.0006;
  scene.add(sun);
  scene.add(sun.target);

  // --- ground --------------------------------------------------------------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(96, 72),
    new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.96, metalness: 0.02 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(480, 480), material(PALETTE.asphaltDark, 1));
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.05;
  scene.add(apron);

  const paintMat = new THREE.MeshBasicMaterial({ color: PALETTE.paintLine, transparent: true, opacity: 0.32 });
  function paintLine(x, z, len, alongZ) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(alongZ ? 0.22 : len, alongZ ? len : 0.22), paintMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.02, z);
    scene.add(m);
  }
  for (const x of [-20, 0, 20]) paintLine(x, 0, 52, true);
  paintLine(0, 20, 84, false);
  paintLine(0, -27, 84, false);

  // --- perimeter -----------------------------------------------------------
  box(scene, 0, 0, -34.5, 94, 4.4, 1, PALETTE.concrete);
  box(scene, 0, 0, 34.5, 94, 4.4, 1, PALETTE.concrete);
  box(scene, -46.5, 0, 0, 1, 4.4, 70, PALETTE.concrete);
  box(scene, 46.5, 0, 0, 1, 4.4, 70, PALETTE.concrete);

  // --- the Depot: site A warehouse -----------------------------------------
  const W = PALETTE.warehouse;
  box(scene, -30, 0, -24, 16.8, 3.4, 0.4, W);                    // north wall
  box(scene, -38, 0, -16, 0.4, 3.4, 16.8, W);                   // west wall
  box(scene, -34.4, 0, -8, 7.6, 3.4, 0.4, W);                   // south wall, west of the door
  box(scene, -25.6, 0, -8, 7.6, 3.4, 0.4, W);                   // south wall, east of the door
  box(scene, -22, 0, -20.4, 0.4, 3.4, 7.6, W);                   // east wall, north of the door
  box(scene, -22, 0, -11.6, 0.4, 3.4, 7.6, W);                   // east wall, south of the door
  box(scene, -30, 3.4, -16, 17.4, 0.35, 17.4, PALETTE.warehouseRoof); // roof slab
  box(scene, -30, 0, -20.6, 12, 2.6, 2.6, PALETTE.containers[3]);     // stored container inside
  box(scene, -34.5, 0, -12, 2.4, 1.3, 1.2, PALETTE.crate);            // interior crates
  box(scene, -34.5, 1.3, -12, 2.4, 1.3, 1.2, PALETTE.crateDark);
  box(scene, -26, 0, -13.5, 1.3, 1.3, 1.3, PALETTE.crate);
  const depotLight = new THREE.PointLight(0xffd9a0, 260, 26, 1.9);
  depotLight.position.set(-30, 3.1, -16);
  scene.add(depotLight);
  for (const lx of [-34, -30, -26]) {
    const strip = new THREE.Mesh(unitBox, new THREE.MeshBasicMaterial({ color: 0xffe2b0 }));
    strip.position.set(lx, 3.32, -16);
    strip.scale.set(2.2, 0.06, 0.3);
    scene.add(strip);
  }

  // --- the Crane Pad: site B -------------------------------------------------
  const L = PALETTE.crane;
  for (const [lx, lz] of [[23, -23], [37, -23], [23, -9], [37, -9]]) {
    box(scene, lx, 0, lz, 1.1, 9, 1.1, L);
  }
  box(scene, 23, 8.6, -16, 1.3, 0.9, 15.5, L, { collide: false });
  box(scene, 37, 8.6, -16, 1.3, 0.9, 15.5, L, { collide: false });
  box(scene, 30, 9.5, -16, 15.5, 0.9, 1.3, L, { collide: false });
  box(scene, 33, 8.2, -16, 2.2, 0.8, 2.2, PALETTE.gunmetal, { collide: false }); // trolley
  box(scene, 33, 5.6, -16, 0.12, 4.6, 0.12, PALETTE.gunmetal, { collide: false }); // cable
  box(scene, 33, 3, -16, 6, 2.6, 2.6, PALETTE.containers[0]); // the hanging load
  const padLight = new THREE.PointLight(0xffc37a, 200, 30, 1.9);
  padLight.position.set(30, 7.6, -16);
  scene.add(padLight);

  // --- container rows --------------------------------------------------------
  container(scene, -14, -20, true, true, 0);
  container(scene, -14, -5, true, false, 1);
  container(scene, -14, 10, true, false, 2);
  container(scene, 0, -15, true, false, 3);
  container(scene, 0, 3, true, true, 4);
  container(scene, 0, 19, false, false, 5);
  container(scene, 14, -20, true, true, 1);
  container(scene, 14, -5, true, false, 2);
  container(scene, 14, 10, true, false, 0);
  container(scene, -30, 14, false, false, 3);
  container(scene, 30, 14, false, false, 4);
  container(scene, 24, -16, true, false, 5);   // cover standing on the Crane Pad
  container(scene, -24, -27.5, false, false, 2);
  container(scene, 24, -27.5, false, false, 3);

  // --- crates and low cover ----------------------------------------------------
  const crateSpots = [
    [-8, -16], [8, -16], [-19, 6], [19, 6], [-30, -2], [30, -2], [-6, 24], [6, 24],
    [0, -31], [-24, 20], [24, 20], [-27, -12.5], [34, -20], [-3, -13], [3, 8],
  ];
  for (const [cx, cz] of crateSpots) box(scene, cx, 0, cz, 2.4, 1.3, 1.2, PALETTE.crate);
  box(scene, -8, 1.3, -16, 1.3, 1.3, 1.2, PALETTE.crateDark);
  box(scene, 8, 1.3, -16, 1.3, 1.3, 1.2, PALETTE.crateDark);

  // --- lamp posts ----------------------------------------------------------------
  for (const [lx, lz] of [[-20, -26], [20, -26], [-20, 14], [20, 14], [0, -8]]) {
    box(scene, lx, 0, lz, 0.22, 5.2, 0.22, PALETTE.gunmetal);
    const head = new THREE.Mesh(unitBox, new THREE.MeshBasicMaterial({ color: PALETTE.lampGlow }));
    head.position.set(lx, 5.3, lz);
    head.scale.set(0.7, 0.18, 0.7);
    scene.add(head);
  }
  const midLight = new THREE.PointLight(0xffc37a, 130, 26, 1.9);
  midLight.position.set(0, 5, -8);
  scene.add(midLight);

  // --- site markings and signs -----------------------------------------------------
  for (const site of SITES) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(site.r - 0.4, site.r, 40),
      new THREE.MeshBasicMaterial({ color: PALETTE.breakers, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(site.x, 0.03, site.z);
    scene.add(ring);
    const letter = new THREE.Mesh(
      new THREE.PlaneGeometry(4.4, 4.4),
      new THREE.MeshBasicMaterial({ map: letterTexture(site.id, '#f5a83d'), transparent: true, opacity: 0.9 }),
    );
    letter.rotation.x = -Math.PI / 2;
    letter.position.set(site.x, 0.035, site.z);
    scene.add(letter);
    box(scene, site.x + site.r + 1.5, 0, site.z, 0.18, 3.1, 0.18, PALETTE.gunmetal);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 1.7),
      new THREE.MeshBasicMaterial({ map: letterTexture(site.id, '#f5a83d'), transparent: true, side: THREE.DoubleSide }),
    );
    sign.position.set(site.x + site.r + 1.5, 2.5, site.z);
    scene.add(sign);
  }

  // --- spawn pads ------------------------------------------------------------------
  function pad(x, z, color) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(11, 3.4),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3 }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.025, z);
    scene.add(m);
  }
  pad(0, 29.5, PALETTE.breakers);
  pad(-30, -29.5, PALETTE.wardens);
  pad(30, -29.5, PALETTE.wardens);

  // --- skyline silhouettes ---------------------------------------------------------
  const sil = PALETTE.asphaltDark;
  const skyline = [
    [-95, -60, 34, 26, 18], [-60, -88, 44, 34, 22], [0, -98, 52, 30, 26], [70, -84, 38, 40, 20],
    [98, -30, 30, 24, 16], [96, 40, 34, 28, 18], [40, 92, 48, 26, 20], [-50, 90, 40, 32, 22], [-96, 30, 30, 22, 15],
  ];
  for (const [sx, sz, w, h, d] of skyline) box(scene, sx, 0, sz, w, h, d, sil, { collide: false, shadow: false });

  // --- navigation graph --------------------------------------------------------------
  const nodes = NAV_NODES.map(([x, z]) => ({ x, z }));
  const adj = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const d = dist2d(nodes[i].x, nodes[i].z, nodes[j].x, nodes[j].z);
      if (d > 31) continue;
      if (losClear(nodes[i].x, 1.1, nodes[i].z, nodes[j].x, 1.1, nodes[j].z)) {
        adj[i].push({ to: j, cost: d });
        adj[j].push({ to: i, cost: d });
      }
    }
  }

  return { sites: SITES, spawns: SPAWNS, nav: { nodes, adj }, holds: HOLDS };
}
