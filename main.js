// SafeRoute XR — 4-way intersection in the browser (Babylon.js + WebXR AR).

// --- Canvas and engine ---
const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true);

// --- HTML buttons and text ---
const statusElement = document.getElementById("status");
const navModeBtn = document.getElementById("nav-mode-btn");
const safetyModeBtn = document.getElementById("safety-mode-btn");
const audioBtn = document.getElementById("audio-btn");
const enterArContainer = document.getElementById("enter-ar-container");
const enterArButton = document.getElementById("enter-ar");
const enterArOverlayButton = document.getElementById("enter-ar-overlay");
const previewOnlyButton = document.getElementById("preview-only-btn");
const lockPlacementBtn = document.getElementById("lock-placement-btn");
const resetPlacementBtn = document.getElementById("reset-placement-btn");

// --- App state ---
let mode = "navigation";
let audioEnabled = false;
let audioContext;
let simpleBeepOscillator = null;

// --- 3D nodes (set when the scene is created) ---
let xrHelper = null;
let intersectionRoot = null;
let riskZoneMat = null;
let crosswalkMeshes = [];
let directionArrow = null;
let labelWaitMesh = null;
let labelCrossMesh = null;
let labelLookMesh = null;

// --- AR placement (smooth tracking, then lock so nothing jitters) ---
let placementLocked = false;
let lastHitTestRaw = null;
let currentAnchorPoint = null;
let hitSmoothingStarted = false;
let anchorSystem = null;
const hitTmpScale = new BABYLON.Vector3();
const hitTargetPos = new BABYLON.Vector3();
const hitTargetQuat = new BABYLON.Quaternion();
const HIT_SMOOTH = 0.1;

// --- Layout sizes (Babylon units: crosswalk, street, preview floor, labels) ---
const INTERSECTION = {
  CROSSWALK_LENGTH: 3,
  CROSSWALK_WIDTH: 0.3,
  STREET_WIDTH: 1.8,
  RISK_ZONE_Y: 0.002,
  CROSSWALK_Y: 0.001,
  ARROW_DIAMETER_BOTTOM: 0.16,
  ARROW_HEIGHT: 0.4,
  ARROW_TESSELLATION: 16,
  ARROW_Y: 0.3,
  ARROW_Z_ALONG_STREET: 1.4,
};

const PREVIEW_GROUND = {
  WIDTH: 24,
  HEIGHT: 24,
  TEXTURE_U_SCALE: 8,
  TEXTURE_V_SCALE: 8,
};

const FLOATING_LABELS = {
  WAIT_CROSS_Y: 1.05,
  WAIT_CROSS_Z: -0.22,
  LOOK_Y: 1.95,
  LOOK_Z: -0.22,
  LOOK_WIDTH: 1.55,
  LOOK_HEIGHT: 0.72,
  RENDER_GROUP_MAIN: 1,
  RENDER_GROUP_LOOK: 2,
};

// Simple trees and bushes around the intersection (same units as the street).
const STREET_DECOR = {
  TREE_RING: 3.35,
  TRUNK_HEIGHT: 0.5,
  TRUNK_DIAM: 0.14,
  FOLIAGE_HEIGHT: 0.85,
  FOLIAGE_BOTTOM: 0.38,
  BUSH_OFFSET: 2.15,
  BUSH_SIZE: 0.28,
};

// Mock traffic light: only advances while in AR (preview uses mode for labels).
const CROSSING_PHASE = {
  WAIT_MS: 4500,
  CROSS_MS: 3500,
};

let crossingPhase = "wait";
let crossingPhaseStartMs = 0;

// Above-and-beyond: 3D traffic lights + phase haptics + prefs persistence.
const STORAGE_KEYS = {
  MODE: "saferoute_xr_mode",
};

let trafficLightMeshes = null;

function loadStringPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (v === "navigation" || v === "safety") return v;
  } catch (e) {
    // ignore
  }
  return fallback;
}

function saveStringPref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    // ignore
  }
}

// Short vibration when the mock signal changes (many Android AR browsers).
function pulsePhaseHaptics(phase) {
  if (typeof navigator === "undefined" || !navigator.vibrate) return;
  const inXR =
    xrHelper && xrHelper.state === BABYLON.WebXRState.IN_XR;
  if (!inXR) return;
  try {
    if (phase === "cross") {
      navigator.vibrate([25, 30, 35]);
    } else {
      navigator.vibrate(18);
    }
  } catch (e) {
    // ignore
  }
}

// Seconds left in the current WAIT or CROSS slice (for status + teaching).
function crossingSecondsRemaining() {
  if (!crossingPhaseStartMs) return 0;
  const now = performance.now();
  const limit =
    crossingPhase === "wait"
      ? CROSSING_PHASE.WAIT_MS
      : CROSSING_PHASE.CROSS_MS;
  return Math.max(0, (limit - (now - crossingPhaseStartMs)) / 1000);
}

// Pedestrian signal on a slim pole: red = wait, green = cross.
function addTrafficLightAssembly(scene, parent) {
  const sw = INTERSECTION.STREET_WIDTH;
  const poleH = 1.35;
  const pole = BABYLON.MeshBuilder.CreateCylinder(
    "tl_pole",
    { height: poleH, diameter: 0.07, tessellation: 12 },
    scene
  );
  pole.parent = parent;
  pole.position.set(sw * 1.15, poleH / 2, -sw * 1.05);
  const poleMat = new BABYLON.StandardMaterial("tl_poleMat", scene);
  poleMat.diffuseColor = new BABYLON.Color3(0.22, 0.22, 0.24);
  pole.material = poleMat;

  const housing = BABYLON.MeshBuilder.CreateBox(
    "tl_housing",
    { width: 0.22, height: 0.62, depth: 0.12 },
    scene
  );
  housing.parent = parent;
  housing.position.set(
    pole.position.x,
    poleH - 0.28,
    pole.position.z + 0.02
  );
  const housingMat = new BABYLON.StandardMaterial("tl_housingMat", scene);
  housingMat.diffuseColor = new BABYLON.Color3(0.12, 0.12, 0.14);
  housing.material = housingMat;

  function makeBulb(name, y, baseColor, emissiveOn) {
    const bulb = BABYLON.MeshBuilder.CreateSphere(
      name,
      { diameter: 0.14, segments: 12 },
      scene
    );
    bulb.parent = parent;
    bulb.position.set(housing.position.x, y, housing.position.z + 0.07);
    const m = new BABYLON.StandardMaterial(name + "Mat", scene);
    m.diffuseColor = baseColor;
    m.specularColor = BABYLON.Color3.Black();
    m.emissiveColor = emissiveOn.clone();
    m.disableLighting = false;
    bulb.material = m;
    return m;
  }

  const redMat = makeBulb(
    "tl_red",
    housing.position.y + 0.18,
    new BABYLON.Color3(0.55, 0.05, 0.05),
    new BABYLON.Color3(0.9, 0, 0)
  );
  const amberMat = makeBulb(
    "tl_amber",
    housing.position.y,
    new BABYLON.Color3(0.45, 0.32, 0.05),
    new BABYLON.Color3(0.95, 0.65, 0.05)
  );
  const greenMat = makeBulb(
    "tl_green",
    housing.position.y - 0.18,
    new BABYLON.Color3(0.05, 0.45, 0.08),
    new BABYLON.Color3(0.05, 0.85, 0.12)
  );

  function applyPhase(phase) {
    const dim = new BABYLON.Color3(0.02, 0.02, 0.02);
    if (phase === "wait") {
      redMat.emissiveColor = new BABYLON.Color3(0.85, 0.05, 0.05);
      amberMat.emissiveColor = dim;
      greenMat.emissiveColor = dim;
    } else {
      redMat.emissiveColor = dim;
      amberMat.emissiveColor = dim;
      greenMat.emissiveColor = new BABYLON.Color3(0.05, 0.9, 0.15);
    }
  }

  applyPhase("wait");
  return { applyPhase };
}

function updateTrafficLightsForPhase() {
  if (trafficLightMeshes) {
    trafficLightMeshes.applyPhase(crossingPhase);
  }
}

// Update the line of text at the top of the page.
function setStatus(text) {
  if (statusElement) {
    statusElement.textContent = text;
  }
}

// Navigation = green path + arrow. Safety = warnings + stronger risk color.
function setMode(newMode) {
  mode = newMode;
  saveStringPref(STORAGE_KEYS.MODE, mode);
  if (mode === "navigation") {
    if (navModeBtn) navModeBtn.classList.add("active");
    if (safetyModeBtn) safetyModeBtn.classList.remove("active");
  } else {
    if (safetyModeBtn) safetyModeBtn.classList.add("active");
    if (navModeBtn) navModeBtn.classList.remove("active");
  }
  updateIntersectionColors();
  updateLabelsText();
  refreshStatusLine();
}

// Status text: in AR show mode + crossing phase; outside AR use mode-only lines.
function refreshStatusLine() {
  const inXR =
    xrHelper && xrHelper.state === BABYLON.WebXRState.IN_XR;
  if (!inXR) {
    if (mode === "navigation") {
      setStatus("Navigation Mode · Follow green path");
    } else {
      setStatus("Safety Mode · Watch red warnings");
    }
    return;
  }

  const layoutVisible =
    intersectionRoot && intersectionRoot.isEnabled();
  if (!placementLocked && !layoutVisible) {
    setStatus(
      "Aim at the floor, then tap the view to lock (tap again to unlock), or use the buttons."
    );
    return;
  }

  let countdown = "";
  if (crossingPhaseStartMs > 0) {
    const sec = crossingSecondsRemaining();
    const whole = Math.max(0, Math.ceil(sec));
    countdown =
      crossingPhase === "wait"
        ? ` · Next cross in ${whole}s`
        : ` · ${whole}s to clear`;
  }

  const modeLabel =
    mode === "navigation" ? "Navigation mode" : "Safety mode";
  const crossingLabel =
    crossingPhase === "wait" ? "WAIT" : "CROSS";
  if (placementLocked) {
    setStatus(
      `Locked · Crossing: ${crossingLabel} · Unlock to move${countdown}`
    );
    return;
  }
  setStatus(
    `${modeLabel} · Crossing: ${crossingLabel} · Tap to lock${countdown}`
  );
}

// Turn the simple beep on or off (needs a user click first on many browsers).
function toggleAudio() {
  audioEnabled = !audioEnabled;
  if (audioBtn) {
    audioBtn.textContent = audioEnabled ? "Audio: On" : "Audio: Off";
  }
  if (audioEnabled) {
    if (!audioContext) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        audioContext = new Ctx();
        if (audioContext.state === "suspended") {
          void audioContext.resume().catch(() => {});
        }
      }
    }
    syncWaitAudioForArPhase();
  } else {
    stopBeep();
  }
}

// Start a quiet steady tone (only used during WAIT in AR).
function playWaitBeep() {
  if (!audioEnabled || !audioContext) return;
  stopBeep();

  const wireAndStart = () => {
    try {
      simpleBeepOscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      simpleBeepOscillator.frequency.value = 440;
      gain.gain.value = 0.05;
      simpleBeepOscillator.connect(gain);
      gain.connect(audioContext.destination);
      simpleBeepOscillator.start();
    } catch (e) {
      console.warn(e);
    }
  };

  if (audioContext.state === "suspended") {
    audioContext.resume().then(wireAndStart).catch(() => {
      wireAndStart();
    });
  } else {
    wireAndStart();
  }
}

// Stop the tone if it is playing.
function stopBeep() {
  if (simpleBeepOscillator) {
    try {
      simpleBeepOscillator.stop();
    } catch (e) {
      // already stopped
    }
    simpleBeepOscillator.disconnect();
    simpleBeepOscillator = null;
  }
}

// Sound only during mock WAIT while in AR; silent on CROSS and outside AR.
function syncWaitAudioForArPhase() {
  if (!audioEnabled || !audioContext) {
    stopBeep();
    return;
  }
  const inXR =
    xrHelper && xrHelper.state === BABYLON.WebXRState.IN_XR;
  if (inXR && crossingPhase === "wait") {
    playWaitBeep();
  } else {
    stopBeep();
  }
}

// Draw text to a canvas texture and put it on a plane (always faces the camera).
function createFloatingLabel(scene, parent, text, cssColor, y, z, opts) {
  opts = opts || {};
  const planeW = opts.width != null ? opts.width : 1.4;
  const planeH = opts.height != null ? opts.height : 0.7;
  const texW = 512;
  const texH = opts.secondLine ? 320 : 256;

  const plane = BABYLON.MeshBuilder.CreatePlane(
    "label_" + text.replace(/\s/g, "_"),
    { width: planeW, height: planeH },
    scene
  );
  plane.parent = parent;
  plane.position.set(0, y, z);
  plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
  // Higher group draws later so this sign can sit on top of others.
  if (typeof opts.renderGroupId === "number") {
    plane.renderingGroupId = opts.renderGroupId;
  }

  const tex = new BABYLON.DynamicTexture(
    "dyn_" + text.replace(/\s/g, "_"),
    { width: texW, height: texH },
    scene,
    false
  );
  const ctx = tex.getContext();
  ctx.fillStyle = "rgba(15,23,42,0.88)";
  ctx.fillRect(0, 0, texW, texH);
  ctx.fillStyle = cssColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (opts.secondLine) {
    ctx.font = "bold 56px Arial";
    ctx.fillText(text, texW / 2, texH * 0.35);
    ctx.fillText(opts.secondLine, texW / 2, texH * 0.68);
  } else {
    ctx.font = "bold 64px Arial";
    ctx.fillText(text, texW / 2, texH / 2);
  }
  tex.update();

  const mat = new BABYLON.StandardMaterial("mat_" + text, scene);
  mat.diffuseTexture = tex;
  mat.emissiveTexture = tex;
  mat.emissiveColor = BABYLON.Color3.White();
  mat.backFaceCulling = false;
  mat.disableLighting = true;
  mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  plane.material = mat;
  return plane;
}

// Low-poly tree (trunk + cone) for sidewalk / corner decoration.
function addSimpleTree(scene, parent, x, z, scale, index) {
  const s = STREET_DECOR;
  const group = new BABYLON.TransformNode("treeGroup_" + index, scene);
  group.parent = parent;
  group.position.set(x, 0, z);
  group.scaling.scaleInPlace(scale);

  const trunk = BABYLON.MeshBuilder.CreateCylinder(
    "treeTrunk_" + index,
    {
      height: s.TRUNK_HEIGHT,
      diameter: s.TRUNK_DIAM,
      tessellation: 8,
    },
    scene
  );
  trunk.parent = group;
  trunk.position.y = s.TRUNK_HEIGHT / 2 + 0.01;
  const trunkMat = new BABYLON.StandardMaterial("treeTrunkMat_" + index, scene);
  trunkMat.diffuseColor = new BABYLON.Color3(0.38, 0.24, 0.14);
  trunk.material = trunkMat;

  const foliage = BABYLON.MeshBuilder.CreateCylinder(
    "treeFoliage_" + index,
    {
      diameterTop: 0,
      diameterBottom: s.FOLIAGE_BOTTOM,
      height: s.FOLIAGE_HEIGHT,
      tessellation: 8,
    },
    scene
  );
  foliage.parent = group;
  foliage.position.y = s.TRUNK_HEIGHT + s.FOLIAGE_HEIGHT / 2;
  const folMat = new BABYLON.StandardMaterial("treeFolMat_" + index, scene);
  folMat.diffuseColor = new BABYLON.Color3(0.1, 0.52, 0.22);
  foliage.material = folMat;
}

// Small rounded bush (squashed sphere) near the corner.
function addBush(scene, parent, x, z, index) {
  const s = STREET_DECOR;
  const bush = BABYLON.MeshBuilder.CreateSphere(
    "bush_" + index,
    { diameter: s.BUSH_SIZE, segments: 8 },
    scene
  );
  bush.parent = parent;
  bush.position.set(x, s.BUSH_SIZE * 0.35, z);
  bush.scaling = new BABYLON.Vector3(1, 0.65, 1);
  const mat = new BABYLON.StandardMaterial("bushMat_" + index, scene);
  mat.diffuseColor = new BABYLON.Color3(0.15, 0.45, 0.18);
  bush.material = mat;
}

// Trees on the diagonals and cardinals; bushes a bit closer to the road.
function addStreetDecor(scene, root) {
  const ring = STREET_DECOR.TREE_RING;
  const treeSpots = [
    [ring, ring],
    [ring, -ring],
    [-ring, ring],
    [-ring, -ring],
    [ring, 0],
    [-ring, 0],
    [0, ring],
    [0, -ring],
  ];
  const treeScales = [0.92, 1.08, 0.88, 1.02, 1.0, 0.95, 1.06, 0.9];
  treeSpots.forEach((p, i) => {
    addSimpleTree(scene, root, p[0], p[1], treeScales[i], i);
  });

  const bo = STREET_DECOR.BUSH_OFFSET;
  const bushSpots = [
    [bo, bo],
    [bo, -bo],
    [-bo, bo],
    [-bo, -bo],
  ];
  bushSpots.forEach((p, i) => {
    addBush(scene, root, p[0], p[1], i);
  });
}

// Build the whole intersection as children of one node (easier to move in AR).
function buildFourWayIntersection(scene) {
  const root = new BABYLON.TransformNode("intersectionRoot", scene);
  const {
    CROSSWALK_LENGTH,
    CROSSWALK_WIDTH,
    STREET_WIDTH,
    RISK_ZONE_Y,
    CROSSWALK_Y,
    ARROW_DIAMETER_BOTTOM,
    ARROW_HEIGHT,
    ARROW_TESSELLATION,
    ARROW_Y,
    ARROW_Z_ALONG_STREET,
  } = INTERSECTION;

  const riskZone = BABYLON.MeshBuilder.CreateGround(
    "riskZone",
    { width: STREET_WIDTH * 2, height: STREET_WIDTH * 2 },
    scene
  );
  riskZone.parent = root;
  riskZone.position.y = RISK_ZONE_Y;
  const riskMat = new BABYLON.StandardMaterial("riskMat", scene);
  riskMat.diffuseColor = new BABYLON.Color3(0.95, 0.2, 0.2);
  riskMat.alpha = 0.5;
  riskMat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  riskZone.material = riskMat;

  const cwList = [];

  // One strip of crosswalk; rotY turns it for east-west vs north-south.
  function addCrosswalk(name, x, z, rotY) {
    const cw = BABYLON.MeshBuilder.CreateGround(
      name,
      { width: CROSSWALK_WIDTH, height: CROSSWALK_LENGTH },
      scene
    );
    cw.parent = root;
    cw.position.set(x, CROSSWALK_Y, z);
    cw.rotation.y = rotY;
    const m = new BABYLON.StandardMaterial(name + "Mat", scene);
    m.diffuseColor = new BABYLON.Color3(0.1, 0.65, 0.2);
    m.alpha = 0.7;
    m.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    cw.material = m;
    cwList.push(cw);
    return cw;
  }

  addCrosswalk("crosswalkNorth", 0, -STREET_WIDTH, 0);
  addCrosswalk("crosswalkSouth", 0, STREET_WIDTH, 0);
  addCrosswalk("crosswalkWest", -STREET_WIDTH, 0, Math.PI / 2);
  addCrosswalk("crosswalkEast", STREET_WIDTH, 0, Math.PI / 2);

  // Cone on its side reads as a forward arrow in navigation mode.
  const arrow = BABYLON.MeshBuilder.CreateCylinder(
    "directionArrow",
    {
      diameterTop: 0,
      diameterBottom: ARROW_DIAMETER_BOTTOM,
      height: ARROW_HEIGHT,
      tessellation: ARROW_TESSELLATION,
    },
    scene
  );
  arrow.parent = root;
  arrow.rotation.z = Math.PI / 2;
  arrow.position.set(0, ARROW_Y, -STREET_WIDTH * ARROW_Z_ALONG_STREET);
  const arrowMat = new BABYLON.StandardMaterial("arrowMat", scene);
  arrowMat.diffuseColor = new BABYLON.Color3(0.1, 0.8, 0.25);
  arrow.material = arrowMat;

  // WAIT/CROSS lower; LOOK stacked above so billboards do not hide each other
  const lw = createFloatingLabel(
    scene,
    root,
    "WAIT - TRAFFIC",
    "#f97316",
    FLOATING_LABELS.WAIT_CROSS_Y,
    FLOATING_LABELS.WAIT_CROSS_Z,
    { renderGroupId: FLOATING_LABELS.RENDER_GROUP_MAIN }
  );
  const lc = createFloatingLabel(
    scene,
    root,
    "CROSS NOW",
    "#22c55e",
    FLOATING_LABELS.WAIT_CROSS_Y,
    FLOATING_LABELS.WAIT_CROSS_Z,
    { renderGroupId: FLOATING_LABELS.RENDER_GROUP_MAIN }
  );
  lc.isVisible = false;
  const ll = createFloatingLabel(
    scene,
    root,
    "LOOK LEFT",
    "#f5f5f5",
    FLOATING_LABELS.LOOK_Y,
    FLOATING_LABELS.LOOK_Z,
    {
      renderGroupId: FLOATING_LABELS.RENDER_GROUP_LOOK,
      width: FLOATING_LABELS.LOOK_WIDTH,
      height: FLOATING_LABELS.LOOK_HEIGHT,
      secondLine: "LOOK RIGHT",
    }
  );

  addStreetDecor(scene, root);

  trafficLightMeshes = addTrafficLightAssembly(scene, root);

  return {
    root,
    riskMat,
    crosswalkMeshes: cwList,
    arrow,
    labelWait: lw,
    labelCross: lc,
    labelLook: ll,
  };
}

// In AR: WAIT/CROSS follow the mock phase. In preview: follow navigation vs safety.
function updateLabelsText() {
  if (!labelWaitMesh || !labelCrossMesh || !labelLookMesh) return;
  labelLookMesh.isVisible = true;

  const inAr =
    xrHelper && xrHelper.state === BABYLON.WebXRState.IN_XR;
  if (inAr) {
    labelWaitMesh.isVisible = crossingPhase === "wait";
    labelCrossMesh.isVisible = crossingPhase === "cross";
  } else if (mode === "navigation") {
    labelWaitMesh.isVisible = false;
    labelCrossMesh.isVisible = true;
  } else {
    labelWaitMesh.isVisible = true;
    labelCrossMesh.isVisible = false;
  }
}

// WAIT phase + timer: use exitedArSession true when leaving AR (stops the clock).
function resetCrossingPhase(exitedArSession) {
  crossingPhase = "wait";
  crossingPhaseStartMs = exitedArSession ? 0 : performance.now();
  updateLabelsText();
  updateTrafficLightsForPhase();
  syncWaitAudioForArPhase();
}

// Crosswalk colors, risk opacity, and arrow on/off from current mode.
function updateIntersectionColors() {
  if (!crosswalkMeshes.length || !riskZoneMat || !directionArrow) return;

  crosswalkMeshes.forEach((cw) => {
    if (mode === "navigation") {
      cw.material.diffuseColor = new BABYLON.Color3(0.1, 0.75, 0.25);
      cw.material.alpha = 0.7;
    } else {
      cw.material.diffuseColor = new BABYLON.Color3(0.95, 0.85, 0.2);
      cw.material.alpha = 0.75;
    }
  });

  if (mode === "navigation") {
    riskZoneMat.alpha = 0.4;
  } else {
    riskZoneMat.alpha = 0.7;
  }

  if (mode === "navigation") {
    directionArrow.isVisible = true;
    directionArrow.material.diffuseColor = new BABYLON.Color3(0.1, 0.8, 0.25);
    directionArrow.position.y = INTERSECTION.ARROW_Y;
  } else {
    directionArrow.isVisible = false;
  }
}

// Main setup: preview scene on desktop, same content in AR on a headset or phone.
const createScene = async function () {
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.02, 0.04, 0.08, 1);

  // Orbit camera for preview only; WebXR uses its own camera in AR.
  const camera = new BABYLON.ArcRotateCamera(
    "camera",
    -Math.PI / 2,
    Math.PI / 2.5,
    12,
    new BABYLON.Vector3(0, 0, 0),
    scene
  );
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 4;
  camera.upperRadiusLimit = 40;

  const light = new BABYLON.HemisphericLight(
    "light1",
    new BABYLON.Vector3(0, 1, 0),
    scene
  );
  light.intensity = 0.75;

  // Big floor so you can spin the scene on a laptop (hidden during AR).
  const ground = BABYLON.MeshBuilder.CreateGround(
    "previewGround",
    { width: PREVIEW_GROUND.WIDTH, height: PREVIEW_GROUND.HEIGHT },
    scene
  );
  const groundMat = new BABYLON.StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new BABYLON.Color3(0.2, 0.2, 0.22);
  groundMat.specularColor = BABYLON.Color3.Black();
  groundMat.diffuseTexture = new BABYLON.Texture(
    "https://www.babylonjs-playground.com/textures/floor.png",
    scene
  );
  groundMat.diffuseTexture.uScale = PREVIEW_GROUND.TEXTURE_U_SCALE;
  groundMat.diffuseTexture.vScale = PREVIEW_GROUND.TEXTURE_V_SCALE;
  ground.material = groundMat;

  const built = buildFourWayIntersection(scene);
  intersectionRoot = built.root;
  riskZoneMat = built.riskMat;
  crosswalkMeshes = built.crosswalkMeshes;
  directionArrow = built.arrow;
  labelWaitMesh = built.labelWait;
  labelCrossMesh = built.labelCross;
  labelLookMesh = built.labelLook;

  intersectionRoot.position = new BABYLON.Vector3(0, 0.01, 0);
  updateIntersectionColors();
  updateLabelsText();

  const savedMode = loadStringPref(STORAGE_KEYS.MODE, "navigation");
  setMode(savedMode === "safety" ? "safety" : "navigation");

  // AR session: find the real floor with hit-test; anchors help lock position.
  const xr = await scene.createDefaultXRExperienceAsync({
    uiOptions: {
      sessionMode: "immersive-ar",
      referenceSpaceType: "local-floor",
    },
    optionalFeatures: ["hit-test", "anchors"],
  });
  xrHelper = xr.baseExperience;

  const fm = xrHelper.featuresManager;
  const hitTest = fm.enableFeature(BABYLON.WebXRHitTest, "latest");
  try {
    anchorSystem = fm.enableFeature(BABYLON.WebXRAnchorSystem, "latest");
  } catch (e) {
    anchorSystem = null;
  }

  // Small disk on the floor while tracking; intersection is parented to it until you lock.
  const marker = BABYLON.MeshBuilder.CreateCylinder(
    "hitMarker",
    { diameter: 0.15, height: 0.01 },
    scene
  );
  marker.rotationQuaternion = new BABYLON.Quaternion();
  marker.isVisible = false;
  const markerMat = new BABYLON.StandardMaterial("markerMat", scene);
  markerMat.diffuseColor = new BABYLON.Color3(0, 1, 0);
  markerMat.alpha = 0.5;
  markerMat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  marker.material = markerMat;

  // Lock only makes sense in AR; Unlock only after something is locked.
  function updatePlacementButtons() {
    const inXR = xrHelper && xrHelper.state === BABYLON.WebXRState.IN_XR;
    if (lockPlacementBtn) {
      lockPlacementBtn.disabled = !inXR || placementLocked;
    }
    if (resetPlacementBtn) {
      resetPlacementBtn.disabled = !inXR || !placementLocked;
    }
  }

  // Go back to following the hit-test (destroys the anchor if there was one).
  function unlockPlacement() {
    placementLocked = false;
    hitSmoothingStarted = false;
    lastHitTestRaw = null;
    if (currentAnchorPoint) {
      try {
        currentAnchorPoint.dispose();
      } catch (e) {
        // ignore
      }
      currentAnchorPoint = null;
    }
    intersectionRoot.setParent(null);
    intersectionRoot.setEnabled(false);
    marker.isVisible = false;
    resetCrossingPhase(false);
    updatePlacementButtons();
    if (xrHelper && xrHelper.state === BABYLON.WebXRState.IN_XR) {
      setStatus("Aim at the floor, then tap Lock to floor");
    }
  }

  // Pin the intersection to the world using an anchor, or just stop moving if no anchors.
  async function lockPlacement() {
    if (
      placementLocked ||
      xrHelper?.state !== BABYLON.WebXRState.IN_XR
    ) {
      return;
    }
    if (!lastHitTestRaw) {
      setStatus("Keep aiming at the floor until the layout appears");
      return;
    }
    try {
      if (anchorSystem) {
        const ap =
          await anchorSystem.addAnchorPointUsingHitTestResultAsync(
            lastHitTestRaw
          );
        intersectionRoot.setParent(null);
        ap.attachedNode = intersectionRoot;
        intersectionRoot.position.set(0, 0, 0);
        intersectionRoot.rotationQuaternion =
          BABYLON.Quaternion.Identity();
        currentAnchorPoint = ap;
      }
      placementLocked = true;
      marker.isVisible = false;
      refreshStatusLine();
    } catch (e) {
      console.warn(e);
      placementLocked = true;
      marker.isVisible = false;
      refreshStatusLine();
    }
    updatePlacementButtons();
  }

  // Each frame: move the marker toward the hit (smooth), unless placement is locked.
  hitTest.onHitTestResultObservable.add((results) => {
    const inXR =
      xrHelper?.state === BABYLON.WebXRState.IN_XR;
    lastHitTestRaw = results.length ? results[0] : null;

    if (placementLocked) {
      return;
    }

    if (results.length && inXR) {
      const hit = results[0];
      hit.transformationMatrix.decompose(
        hitTmpScale,
        hitTargetQuat,
        hitTargetPos
      );

      if (!hitSmoothingStarted) {
        marker.position.copyFrom(hitTargetPos);
        marker.rotationQuaternion.copyFrom(hitTargetQuat);
        hitSmoothingStarted = true;
      } else {
        BABYLON.Vector3.LerpToRef(
          marker.position,
          hitTargetPos,
          HIT_SMOOTH,
          marker.position
        );
        BABYLON.Quaternion.SlerpToRef(
          marker.rotationQuaternion,
          hitTargetQuat,
          HIT_SMOOTH,
          marker.rotationQuaternion
        );
        marker.rotationQuaternion.normalize();
      }

      marker.isVisible = true;
      intersectionRoot.setParent(marker);
      intersectionRoot.position = BABYLON.Vector3.Zero();
      intersectionRoot.rotationQuaternion = BABYLON.Quaternion.Identity();
      intersectionRoot.setEnabled(true);
    } else if (inXR) {
      marker.isVisible = false;
      intersectionRoot.setEnabled(false);
    }
  });

  // Entering AR hides the fake ground; leaving AR puts the preview back.
  xrHelper.onStateChangedObservable.add((state) => {
    if (state === BABYLON.WebXRState.IN_XR) {
      ground.setEnabled(false);
      placementLocked = false;
      hitSmoothingStarted = false;
      lastHitTestRaw = null;
      intersectionRoot.setEnabled(false);
      if (enterArContainer) enterArContainer.style.display = "none";
      resetCrossingPhase(false);
      attachArPlacementTap();
      setStatus(
        "Aim at the floor, then tap the view to lock (tap again to unlock), or use the buttons."
      );
      updatePlacementButtons();
    } else if (state === BABYLON.WebXRState.NOT_IN_XR) {
      detachArPlacementTap();
      resetCrossingPhase(true);
      placementLocked = false;
      hitSmoothingStarted = false;
      lastHitTestRaw = null;
      if (currentAnchorPoint) {
        try {
          currentAnchorPoint.dispose();
        } catch (e) {
          // ignore
        }
        currentAnchorPoint = null;
      }
      ground.setEnabled(true);
      intersectionRoot.setParent(null);
      intersectionRoot.position = new BABYLON.Vector3(0, 0.01, 0);
      intersectionRoot.rotationQuaternion = null;
      intersectionRoot.rotation = new BABYLON.Vector3(0, 0, 0);
      intersectionRoot.setEnabled(true);
      marker.isVisible = false;
      if (enterArContainer) enterArContainer.style.display = "flex";
      refreshStatusLine();
      updatePlacementButtons();
    }
  });

  // Mock crossing phases in AR + risk zone pulse in safety mode.
  scene.onBeforeRenderObservable.add(() => {
    if (xrHelper && xrHelper.state === BABYLON.WebXRState.IN_XR) {
      const now = performance.now();
      const limit =
        crossingPhase === "wait"
          ? CROSSING_PHASE.WAIT_MS
          : CROSSING_PHASE.CROSS_MS;
      if (now - crossingPhaseStartMs >= limit) {
        crossingPhase = crossingPhase === "wait" ? "cross" : "wait";
        crossingPhaseStartMs = now;
        pulsePhaseHaptics(crossingPhase);
        updateLabelsText();
        updateTrafficLightsForPhase();
        refreshStatusLine();
        syncWaitAudioForArPhase();
      }
    }

    if (xrHelper && xrHelper.state === BABYLON.WebXRState.IN_XR) {
      refreshStatusLine();
    }

    if (!riskZoneMat || !intersectionRoot || !intersectionRoot.isEnabled()) return;
    const t = performance.now();
    if (mode === "safety") {
      const base = 0.55;
      const amp = 0.2;
      riskZoneMat.alpha = base + amp * Math.sin(t * 0.004);
    } else {
      riskZoneMat.alpha = mode === "navigation" ? 0.4 : 0.7;
    }

    if (
      mode === "navigation" &&
      directionArrow &&
      directionArrow.isVisible
    ) {
      directionArrow.position.y =
        INTERSECTION.ARROW_Y + 0.045 * Math.sin(t * 0.0032);
    }
  });

  // --- Clicks on the page ---
  if (navModeBtn) {
    navModeBtn.addEventListener("click", () => setMode("navigation"));
  }
  if (safetyModeBtn) {
    safetyModeBtn.addEventListener("click", () => setMode("safety"));
  }
  if (audioBtn) {
    audioBtn.addEventListener("click", () => toggleAudio());
  }

  if (previewOnlyButton) {
    previewOnlyButton.addEventListener("click", () => {
      if (enterArContainer) enterArContainer.style.display = "none";
      setStatus("Desktop preview · drag to orbit the scene");
    });
  }

  // Tap on the 3D view during AR: lock when tracking, unlock when already locked.
  let arPlacementTapObserver = null;

  function detachArPlacementTap() {
    if (arPlacementTapObserver) {
      scene.onPointerObservable.remove(arPlacementTapObserver);
      arPlacementTapObserver = null;
    }
  }

  function attachArPlacementTap() {
    detachArPlacementTap();
    arPlacementTapObserver = scene.onPointerObservable.add((pointerInfo) => {
      if (pointerInfo.type !== BABYLON.PointerEventTypes.POINTERDOWN) {
        return;
      }
      if (!xrHelper || xrHelper.state !== BABYLON.WebXRState.IN_XR) {
        return;
      }
      if (placementLocked) {
        unlockPlacement();
        return;
      }
      if (
        lastHitTestRaw &&
        intersectionRoot &&
        intersectionRoot.isEnabled()
      ) {
        void lockPlacement();
      }
    });
  }

  // User gesture required to enter AR in most browsers.
  async function startAR() {
    if (!xrHelper) return;
    try {
      await xrHelper.enterXRAsync("immersive-ar", "local-floor");
      attachArPlacementTap();
      setStatus(
        "Aim at the floor, then tap the view to lock (tap again to unlock), or use the buttons."
      );
    } catch (err) {
      console.error(err);
      if (enterArContainer) {
        enterArContainer.style.display = "flex";
      }
      alert(
        "Could not start AR. Use a supported phone browser or try Preview."
      );
    }
  }

  if (enterArButton) {
    enterArButton.addEventListener("click", startAR);
  }
  if (enterArOverlayButton) {
    enterArOverlayButton.addEventListener("click", startAR);
  }

  if (lockPlacementBtn) {
    lockPlacementBtn.addEventListener("click", () => {
      lockPlacement();
    });
  }
  if (resetPlacementBtn) {
    resetPlacementBtn.addEventListener("click", () => {
      unlockPlacement();
    });
  }

  updatePlacementButtons();

  return scene;
};

// Start the render loop after the scene is ready (XR setup is async).
createScene()
  .then((scene) => {
    engine.runRenderLoop(function () {
      scene.render();
    });
  })
  .catch((err) => {
    console.error(err);
    if (statusElement) {
      statusElement.textContent =
        "Could not start the 3D scene. See the browser console.";
    }
  });

// Keep the canvas full window when the browser size changes.
window.addEventListener("resize", function () {
  engine.resize();
});
