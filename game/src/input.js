// Keyboard and mouse state, with pointer lock. The simulation polls `keys` and drains the
// look delta once per frame; nothing here knows about the game.
export function createInput(element, onLockChange) {
  const keys = new Set();
  const look = { x: 0, y: 0 };
  const state = {
    keys,
    firing: false,
    aiming: false,       // right mouse held (aim down sights)
    locked: false,
    wheel: 0,            // accumulated wheel delta, drained by the player controller
  };

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab') e.preventDefault();
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => {
    keys.clear();
    state.firing = false;
    state.aiming = false;
  });
  element.addEventListener('mousedown', (e) => {
    if (!state.locked) return;
    if (e.button === 0) state.firing = true;
    if (e.button === 2) state.aiming = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) state.firing = false;
    if (e.button === 2) state.aiming = false;
  });
  element.addEventListener('contextmenu', (e) => e.preventDefault());
  element.addEventListener('wheel', (e) => { state.wheel += Math.sign(e.deltaY); }, { passive: true });
  document.addEventListener('mousemove', (e) => {
    if (!state.locked) return;
    look.x += e.movementX || 0;
    look.y += e.movementY || 0;
  });
  document.addEventListener('pointerlockchange', () => {
    state.locked = document.pointerLockElement === element;
    if (!state.locked) {
      state.firing = false;
      state.aiming = false;
    }
    onLockChange(state.locked);
  });

  return {
    state,
    takeLook() {
      const taken = { x: look.x, y: look.y };
      look.x = 0;
      look.y = 0;
      return taken;
    },
    takeWheel() {
      const taken = state.wheel;
      state.wheel = 0;
      return taken;
    },
    requestLock() {
      element.requestPointerLock();
    },
  };
}
