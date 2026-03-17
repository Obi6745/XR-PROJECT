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

