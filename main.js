import * as THREE from "https://unpkg.com/three@0.165.0/build/three.module.js";
import { ARButton } from "https://unpkg.com/three@0.165.0/examples/jsm/webxr/ARButton.js";

let camera;
let scene;
let renderer;

let hitTestSource = null;
let hitTestSourceRequested = false;

let reticle;
let intersectionGroup;
let labelsGroup;

let mode = "navigation"; // "navigation" or "safety"
let audioEnabled = false;
let audioContext;
let simpleBeepOscillator = null;

const statusElement = document.getElementById("status");
const navModeBtn = document.getElementById("nav-mode-btn");
const safetyModeBtn = document.getElementById("safety-mode-btn");
const audioBtn = document.getElementById("audio-btn");
const enterArContainer = document.getElementById("enter-ar-container");
const enterArButton = document.getElementById("enter-ar");

function setStatus(text) {
  if (statusElement) {
    statusElement.textContent = text;
  }
}

function setMode(newMode) {
  mode = newMode;

  if (mode === "navigation") {
    navModeBtn.classList.add("active");
    safetyModeBtn.classList.remove("active");
    setStatus("Navigation Mode · Follow green path");
  } else {
    safetyModeBtn.classList.add("active");
    navModeBtn.classList.remove("active");
    setStatus("Safety Mode · Watch red warnings");
  }

  updateIntersectionColors();
  updateLabelsText();
}

function toggleAudio() {
  audioEnabled = !audioEnabled;
  audioBtn.textContent = audioEnabled ? "Audio: On" : "Audio: Off";

  if (audioEnabled) {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
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
      // ignore
    }
    simpleBeepOscillator.disconnect();
    simpleBeepOscillator = null;
  }
}

function initThree() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.01,
    20
  );

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  const light = new THREE.HemisphereLight(0xffffff, 0xbbbbbb, 1);
  scene.add(light);

  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: 0x22c55e,
      transparent: true,
      opacity: 0.8,
    })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  intersectionGroup = new THREE.Group();
  intersectionGroup.visible = false;
  scene.add(intersectionGroup);

  labelsGroup = new THREE.Group();
  labelsGroup.visible = false;
  scene.add(labelsGroup);

  createIntersectionMeshes();
  createLabelMeshes();

  window.addEventListener("resize", onWindowResize, false);

  const arButton = ARButton.createButton(renderer, {
    requiredFeatures: ["hit-test"],
  });
  arButton.style.display = "none";
  document.body.appendChild(arButton);

  enterArButton.disabled = false;
  enterArButton.addEventListener("click", () => {
    if (navigator.xr) {
      renderer.xr.setSessionInit({ requiredFeatures: ["hit-test"] });
      renderer.xr
        .getSession()
        ?.end()
        .catch(() => {});
        navigator.xr.isSessionSupported("immersive-ar").then((supported) => {
        if (supported) {
          navigator.xr
            .requestSession("immersive-ar", {
              requiredFeatures: ["hit-test"],
            })
            .then((session) => {
              renderer.xr.setSession(session);
              enterArContainer.style.display = "none";
              setStatus("Move phone to find ground");
              session.addEventListener("end", () => {
                enterArContainer.style.display = "flex";
                intersectionGroup.visible = false;
                labelsGroup.visible = false;
                hitTestSource = null;
                hitTestSourceRequested = false;
              });
            });
        } else {
          alert(
            "WebXR AR is not supported on this device or browser. Try a mobile browser like Chrome or Firefox Reality."
          );
        }
      });
    } else {
      alert(
        "WebXR not available in this browser. Use a WebXR-capable mobile browser."
      );
    }
  });

  renderer.setAnimationLoop(render);
}

function createIntersectionMeshes() {
  const crosswalkLength = 3;
  const crosswalkWidth = 0.3;
  const streetWidth = 1.8;

  const safeMaterial = new THREE.MeshBasicMaterial({
    color: 0x16a34a,
    transparent: true,
    opacity: 0.6,
  });

  const riskMaterial = new THREE.MeshBasicMaterial({
    color: 0xef4444,
    transparent: true,
    opacity: 0.5,
  });

  const riskZoneGeometry = new THREE.PlaneGeometry(streetWidth * 2, streetWidth * 2);
  const riskZone = new THREE.Mesh(riskZoneGeometry, riskMaterial);
  riskZone.rotation.x = -Math.PI / 2;
  riskZone.position.set(0, 0.001, 0);
  riskZone.name = "riskZone";
  intersectionGroup.add(riskZone);

  const crosswalkGeometry = new THREE.PlaneGeometry(crosswalkWidth, crosswalkLength);

  const north = new THREE.Mesh(crosswalkGeometry, safeMaterial.clone());
  north.rotation.x = -Math.PI / 2;
  north.position.set(0, 0.001, -streetWidth);
  north.name = "crosswalkNorth";
  intersectionGroup.add(north);

  const south = new THREE.Mesh(crosswalkGeometry, safeMaterial.clone());
  south.rotation.x = -Math.PI / 2;
  south.position.set(0, 0.001, streetWidth);
  south.name = "crosswalkSouth";
  intersectionGroup.add(south);

  const west = new THREE.Mesh(crosswalkGeometry, safeMaterial.clone());
  west.rotation.x = -Math.PI / 2;
  west.rotation.z = Math.PI / 2;
  west.position.set(-streetWidth, 0.001, 0);
  west.name = "crosswalkWest";
  intersectionGroup.add(west);

  const east = new THREE.Mesh(crosswalkGeometry, safeMaterial.clone());
  east.rotation.x = -Math.PI / 2;
  east.rotation.z = Math.PI / 2;
  east.position.set(streetWidth, 0.001, 0);
  east.name = "crosswalkEast";
  intersectionGroup.add(east);

  const arrowGeometry = new THREE.ConeGeometry(0.08, 0.4, 16);
  const arrowMaterial = new THREE.MeshBasicMaterial({ color: 0x22c55e });
  const arrow = new THREE.Mesh(arrowGeometry, arrowMaterial);
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.set(0, 0.3, -streetWidth * 1.4);
  arrow.name = "directionArrow";
  intersectionGroup.add(arrow);
}

function createLabelMeshes() {
  const createLabel = (text, color, height, zOffset) => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "rgba(15,23,42,0.8)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = color;
    ctx.font = "bold 72px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
    });
    const geometry = new THREE.PlaneGeometry(1.4, 0.7);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(0, height, zOffset);
    mesh.name = `label_${text}`;
    return mesh;
  };

  const labelWait = createLabel("WAIT - TRAFFIC", "#f97316", 1.3, -0.2);
  labelWait.name = "labelWait";
  labelsGroup.add(labelWait);

  const labelCross = createLabel("CROSS NOW", "#22c55e", 1.3, -0.2);
  labelCross.visible = false;
  labelCross.name = "labelCross";
  labelsGroup.add(labelCross);

  const labelLook = createLabel("LOOK LEFT / RIGHT", "#e5e7eb", 1, 0.9);
  labelLook.name = "labelLook";
  labelsGroup.add(labelLook);
}

function updateIntersectionColors() {
  if (!intersectionGroup) return;
  intersectionGroup.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (child.name.startsWith("crosswalk")) {
      if (mode === "navigation") {
        child.material.color.setHex(0x22c55e);
        child.material.opacity = 0.7;
      } else {
        child.material.color.setHex(0xfacc15);
        child.material.opacity = 0.75;
      }
    }
    if (child.name === "riskZone") {
      if (mode === "navigation") {
        child.material.opacity = 0.4;
      } else {
        child.material.opacity = 0.7;
      }
    }
    if (child.name === "directionArrow") {
      if (mode === "navigation") {
        child.visible = true;
        child.material.color.setHex(0x22c55e);
      } else {
        child.visible = false;
      }
    }
  });
}
