// SafeRoute XR — Babylon.js WebXR final prototype (scene, lights, materials, WebXR hit-test)

const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true);

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

let mode = "navigation";
let audioEnabled = false;
let audioContext;
let simpleBeepOscillator = null;

// Filled after the scene builds (for AR enter / exit)
let xrHelper = null;
let intersectionRoot = null;
let riskZoneMat = null;
let crosswalkMeshes = [];
let directionArrow = null;
let labelWaitMesh = null;
let labelCrossMesh = null;
let labelLookMesh = null;

// AR placement: smooth hit-test, then lock with anchor (or freeze) so content does not jitter
let placementLocked = false;
let lastHitTestRaw = null;
let currentAnchorPoint = null;
let hitSmoothingStarted = false;
let anchorSystem = null;
const hitTmpScale = new BABYLON.Vector3();
const hitTargetPos = new BABYLON.Vector3();
const hitTargetQuat = new BABYLON.Quaternion();
const HIT_SMOOTH = 0.1;

function setStatus(text) {
  if (statusElement) {
    statusElement.textContent = text;
  }
}

function setMode(newMode) {
  mode = newMode;
  if (mode === "navigation") {
    if (navModeBtn) navModeBtn.classList.add("active");
    if (safetyModeBtn) safetyModeBtn.classList.remove("active");
    setStatus("Navigation Mode · Follow green path");
  } else {
    if (safetyModeBtn) safetyModeBtn.classList.add("active");
    if (navModeBtn) navModeBtn.classList.remove("active");
    setStatus("Safety Mode · Watch red warnings");
  }
  updateIntersectionColors();
  updateLabelsText();
}

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
      }
    }
    playWaitBeep();
  } else {
    stopBeep();
  }
}

function playWaitBeep() {
  if (!audioEnabled || !audioContext) return;
  stopBeep();
  simpleBeepOscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  simpleBeepOscillator.frequency.value = 440;
  gain.gain.value = 0.05;
  simpleBeepOscillator.connect(gain);
  gain.connect(audioContext.destination);
  simpleBeepOscillator.start();
}

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

// Text on a plane using a dynamic texture
function createFloatingLabel(scene, parent, text, cssColor, y, z) {
  const plane = BABYLON.MeshBuilder.CreatePlane(
    "label_" + text.replace(/\s/g, "_"),
    { width: 1.4, height: 0.7 },
    scene
  );
  plane.parent = parent;
  plane.position.set(0, y, z);
  plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;

  const tex = new BABYLON.DynamicTexture(
    "dyn_" + text,
    { width: 512, height: 256 },
    scene,
    false
  );
  const ctx = tex.getContext();
  ctx.fillStyle = "rgba(15,23,42,0.88)";
  ctx.fillRect(0, 0, 512, 256);
  ctx.fillStyle = cssColor;
  ctx.font = "bold 64px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 128);
  tex.update();

  const mat = new BABYLON.StandardMaterial("mat_" + text, scene);
  mat.diffuseTexture = tex;
  mat.emissiveTexture = tex;
  mat.emissiveColor = BABYLON.Color3.White();
  mat.backFaceCulling = false;
  mat.disableLighting = true;
  plane.material = mat;
  return plane;
}

// Four crosswalk strips, center risk area, arrow (cone), and labels under one parent node
function buildFourWayIntersection(scene) {
  const root = new BABYLON.TransformNode("intersectionRoot", scene);
  const crosswalkLength = 3;
  const crosswalkWidth = 0.3;
  const streetWidth = 1.8;

  const riskZone = BABYLON.MeshBuilder.CreateGround(
    "riskZone",
    { width: streetWidth * 2, height: streetWidth * 2 },
    scene
  );
  riskZone.parent = root;
  riskZone.position.y = 0.002;
  const riskMat = new BABYLON.StandardMaterial("riskMat", scene);
  riskMat.diffuseColor = new BABYLON.Color3(0.95, 0.2, 0.2);
  riskMat.alpha = 0.5;
  riskMat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  riskZone.material = riskMat;

  const cwList = [];

  function addCrosswalk(name, x, z, rotY) {
    const cw = BABYLON.MeshBuilder.CreateGround(
      name,
      { width: crosswalkWidth, height: crosswalkLength },
      scene
    );
    cw.parent = root;
    cw.position.set(x, 0.001, z);
    cw.rotation.y = rotY;
    const m = new BABYLON.StandardMaterial(name + "Mat", scene);
    m.diffuseColor = new BABYLON.Color3(0.1, 0.65, 0.2);
    m.alpha = 0.7;
    m.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    cw.material = m;
    cwList.push(cw);
    return cw;
  }

  addCrosswalk("crosswalkNorth", 0, -streetWidth, 0);
  addCrosswalk("crosswalkSouth", 0, streetWidth, 0);
  addCrosswalk("crosswalkWest", -streetWidth, 0, Math.PI / 2);
  addCrosswalk("crosswalkEast", streetWidth, 0, Math.PI / 2);

  const arrow = BABYLON.MeshBuilder.CreateCylinder(
    "directionArrow",
    {
      diameterTop: 0,
      diameterBottom: 0.16,
      height: 0.4,
      tessellation: 16,
    },
    scene
  );
  arrow.parent = root;
  arrow.rotation.z = Math.PI / 2;
  arrow.position.set(0, 0.3, -streetWidth * 1.4);
  const arrowMat = new BABYLON.StandardMaterial("arrowMat", scene);
  arrowMat.diffuseColor = new BABYLON.Color3(0.1, 0.8, 0.25);
  arrow.material = arrowMat;

  const lw = createFloatingLabel(scene, root, "WAIT - TRAFFIC", "#f97316", 1.3, -0.2);
  const lc = createFloatingLabel(scene, root, "CROSS NOW", "#22c55e", 1.3, -0.2);
  lc.isVisible = false;
  const ll = createFloatingLabel(scene, root, "LOOK LEFT / RIGHT", "#e5e7eb", 1, 0.9);

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

function updateLabelsText() {
  if (!labelWaitMesh || !labelCrossMesh || !labelLookMesh) return;
  if (mode === "navigation") {
    labelWaitMesh.isVisible = false;
    labelCrossMesh.isVisible = true;
    labelLookMesh.isVisible = true;
  } else {
    labelWaitMesh.isVisible = true;
    labelCrossMesh.isVisible = false;
    labelLookMesh.isVisible = true;
  }
}

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
  } else {
    directionArrow.isVisible = false;
  }
}

const createScene = async function () {
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.02, 0.04, 0.08, 1);

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

  // Desktop preview: ground mesh with a tiled diffuse texture
  const ground = BABYLON.MeshBuilder.CreateGround(
    "previewGround",
    { width: 24, height: 24 },
    scene
  );
  const groundMat = new BABYLON.StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new BABYLON.Color3(0.2, 0.2, 0.22);
  groundMat.specularColor = BABYLON.Color3.Black();
  groundMat.diffuseTexture = new BABYLON.Texture(
    "https://www.babylonjs-playground.com/textures/floor.png",
    scene
  );
  groundMat.diffuseTexture.uScale = 8;
  groundMat.diffuseTexture.vScale = 8;
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

  // WebXR immersive AR with hit-test; anchors optional for stable placement
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

  function updatePlacementButtons() {
    const inXR = xrHelper && xrHelper.state === BABYLON.WebXRState.IN_XR;
    if (lockPlacementBtn) {
      lockPlacementBtn.disabled = !inXR || placementLocked;
    }
    if (resetPlacementBtn) {
      resetPlacementBtn.disabled = !inXR || !placementLocked;
    }
  }

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
    updatePlacementButtons();
    if (xrHelper && xrHelper.state === BABYLON.WebXRState.IN_XR) {
      setStatus("Aim at the floor, then tap Lock to floor");
    }
  }

  async function lockPlacement() {
    if (placementLocked || xrHelper.state !== BABYLON.WebXRState.IN_XR) {
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
      setStatus("Locked · tap Unlock to move");
    } catch (e) {
      console.warn(e);
      placementLocked = true;
      marker.isVisible = false;
      setStatus("Locked (no anchor) · tap Unlock to move");
    }
    updatePlacementButtons();
  }

  hitTest.onHitTestResultObservable.add((results) => {
    const inXR = xrHelper.state === BABYLON.WebXRState.IN_XR;
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

  xrHelper.onStateChangedObservable.add((state) => {
    if (state === BABYLON.WebXRState.IN_XR) {
      ground.setEnabled(false);
      placementLocked = false;
      hitSmoothingStarted = false;
      lastHitTestRaw = null;
      intersectionRoot.setEnabled(false);
      if (enterArContainer) enterArContainer.style.display = "none";
      setStatus("Aim at the floor, then tap Lock to floor");
      updatePlacementButtons();
    } else if (state === BABYLON.WebXRState.NOT_IN_XR) {
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
      setStatus("SafeRoute XR · Ready");
      updatePlacementButtons();
    }
  });

  // Pulse red risk zone in safety mode
  scene.onBeforeRenderObservable.add(() => {
    if (!riskZoneMat || !intersectionRoot || !intersectionRoot.isEnabled()) return;
    const t = performance.now();
    if (mode === "safety") {
      const base = 0.55;
      const amp = 0.2;
      riskZoneMat.alpha = base + amp * Math.sin(t * 0.004);
    } else {
      riskZoneMat.alpha = mode === "navigation" ? 0.4 : 0.7;
    }
  });

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

  async function startAR() {
    if (!xrHelper) return;
    try {
      await xrHelper.enterXRAsync("immersive-ar", "local-floor");
    } catch (err) {
      console.error(err);
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

createScene().then((scene) => {
  engine.runRenderLoop(function () {
    scene.render();
  });
});

window.addEventListener("resize", function () {
  engine.resize();
});
