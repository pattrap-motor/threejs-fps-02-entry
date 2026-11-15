// Movement collision and raycasts against the map's axis-aligned boxes.
// Fighters are capsules reduced to a footprint circle plus a height; bullets are rays
// tested against world boxes, fighter body boxes and fighter head spheres.
import { G } from './state.js';

// Filled by map.js: { minX, minY, minZ, maxX, maxY, maxZ }.
export const colliders = [];

const GRAVITY = 13;
export const BODY_RADIUS = 0.38;

export function bodyHeight(f) {
  return 1.78 - f.crouch * 0.52;
}

export function eyeHeight(f) {
  return 1.62 - f.crouch * 0.44;
}

// Advance one fighter's body: velocity, gravity, then resolve the footprint circle
// against every collider whose vertical span overlaps the body.
export function moveBody(f, dt) {
  f.vel.y -= GRAVITY * dt;
  f.pos.x += f.vel.x * dt;
  f.pos.z += f.vel.z * dt;
  f.pos.y += f.vel.y * dt;
  if (f.pos.y <= 0) {
    f.pos.y = 0;
    f.vel.y = 0;
    f.onGround = true;
  } else {
    f.onGround = false;
  }
  const h = bodyHeight(f);
  for (const c of colliders) {
    if (c.minY >= f.pos.y + h || c.maxY <= f.pos.y) continue;
    const nearX = Math.max(c.minX, Math.min(f.pos.x, c.maxX));
    const nearZ = Math.max(c.minZ, Math.min(f.pos.z, c.maxZ));
    const dx = f.pos.x - nearX;
    const dz = f.pos.z - nearZ;
    const d2 = dx * dx + dz * dz;
    if (d2 >= BODY_RADIUS * BODY_RADIUS) continue;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      f.pos.x = nearX + (dx / d) * BODY_RADIUS;
      f.pos.z = nearZ + (dz / d) * BODY_RADIUS;
    } else {
      // Centre inside the box footprint: push out along the smaller penetration.
      const pushLeft = f.pos.x - c.minX + BODY_RADIUS;
      const pushRight = c.maxX - f.pos.x + BODY_RADIUS;
      const pushNear = f.pos.z - c.minZ + BODY_RADIUS;
      const pushFar = c.maxZ - f.pos.z + BODY_RADIUS;
      const m = Math.min(pushLeft, pushRight, pushNear, pushFar);
      if (m === pushLeft) f.pos.x = c.minX - BODY_RADIUS;
      else if (m === pushRight) f.pos.x = c.maxX + BODY_RADIUS;
      else if (m === pushNear) f.pos.z = c.minZ - BODY_RADIUS;
      else f.pos.z = c.maxZ + BODY_RADIUS;
    }
  }
  // The yard fence.
  f.pos.x = Math.max(-45.4, Math.min(45.4, f.pos.x));
  f.pos.z = Math.max(-33.4, Math.min(33.4, f.pos.z));
}

// Slab test: distance along the ray to a box, or -1 for a miss. Written with plain
// scalars — this runs for every collider on every shot and sight line, so it must
// not allocate.
function rayBox(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ) {
  let tmin = 0;
  let tmax = Infinity;
  if (Math.abs(dx) < 1e-9) {
    if (ox < minX || ox > maxX) return -1;
  } else {
    let t1 = (minX - ox) / dx;
    let t2 = (maxX - ox) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  if (Math.abs(dy) < 1e-9) {
    if (oy < minY || oy > maxY) return -1;
  } else {
    let t1 = (minY - oy) / dy;
    let t2 = (maxY - oy) / dy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  if (Math.abs(dz) < 1e-9) {
    if (oz < minZ || oz > maxZ) return -1;
  } else {
    let t1 = (minZ - oz) / dz;
    let t2 = (maxZ - oz) / dz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  return tmin;
}

function rayCollider(ox, oy, oz, dx, dy, dz, c) {
  return rayBox(ox, oy, oz, dx, dy, dz, c.minX, c.minY, c.minZ, c.maxX, c.maxY, c.maxZ);
}

function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox;
  const ly = cy - oy;
  const lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return -1;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  if (d2 > r * r) return -1;
  return tca - Math.sqrt(r * r - d2);
}

// Does a smoke cloud sit on this segment? Smoke blocks sight and perception.
function smokeBlocks(ax, ay, az, bx, by, bz) {
  for (const s of G.smokes) {
    if (s.until < G.time) continue;
    // Distance from the smoke centre to the segment.
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const len2 = abx * abx + aby * aby + abz * abz || 1;
    let t = ((s.x - ax) * abx + (1.4 - ay) * aby + (s.z - az) * abz) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + abx * t - s.x;
    const py = ay + aby * t - 1.4;
    const pz = az + abz * t - s.z;
    if (px * px + py * py + pz * pz < s.r * s.r) return true;
  }
  return false;
}

// Line of sight between two points: world boxes and smoke block it, fighters do not.
export function losClear(ax, ay, az, bx, by, bz) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return true;
  const inv = 1 / dist;
  for (const c of colliders) {
    const t = rayCollider(ax, ay, az, dx * inv, dy * inv, dz * inv, c);
    if (t > 0.01 && t < dist - 0.01) return false;
  }
  return !smokeBlocks(ax, ay, az, bx, by, bz);
}

// A fired shot: nearest hit among world boxes and every living fighter except the shooter.
// Returns { dist, x, y, z, fighter, part } — fighter null for a world hit, part 'head'|'body'.
export function rayHit(ox, oy, oz, dx, dy, dz, maxDist, shooter) {
  let best = maxDist;
  let hitFighter = null;
  let part = null;
  for (const c of colliders) {
    const t = rayCollider(ox, oy, oz, dx, dy, dz, c);
    if (t > 0 && t < best) {
      best = t;
      hitFighter = null;
      part = null;
    }
  }
  for (const f of G.fighters) {
    if (!f.alive || f === shooter) continue;
    const h = bodyHeight(f);
    const tb = rayBox(ox, oy, oz, dx, dy, dz,
      f.pos.x - 0.34, f.pos.y, f.pos.z - 0.34,
      f.pos.x + 0.34, f.pos.y + h - 0.22, f.pos.z + 0.34);
    if (tb > 0 && tb < best) {
      best = tb;
      hitFighter = f;
      part = 'body';
    }
    const th = raySphere(ox, oy, oz, dx, dy, dz, f.pos.x, f.pos.y + h - 0.11, f.pos.z, 0.17);
    if (th > 0 && th < best) {
      best = th;
      hitFighter = f;
      part = 'head';
    }
  }
  return {
    dist: best,
    x: ox + dx * best,
    y: oy + dy * best,
    z: oz + dz * best,
    fighter: hitFighter,
    part,
  };
}
