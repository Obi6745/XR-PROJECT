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
