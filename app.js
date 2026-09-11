"use strict";

const LEVEL_TARGETS = [60, 30, 0, -30, -60];
const SHOTS_PER_LEVEL = 8;
const TOTAL_SHOTS = LEVEL_TARGETS.length * SHOTS_PER_LEVEL;

const TOLERANCE = 5;
const RANGE = 25;
const SMOOTHING = 0.18;

const JPEG_QUALITY = 0.92;
const SHOT_AR = 3 / 4;  // width/height, in portrait
const LONG_EDGE = 1920; // canvas fallback only: cap the grab at 1440x1920

// Measured on a Xiaomi (Android 16): the still menu holds 2448x3264, 1920x2560 and
// 1440x1920 at a true 3:4, plus a 2256x4000 16:9 that is the DEFAULT and crops 25%
// off the width. So always ask for a size - never take takePhoto()'s default.
const STILL_SETTINGS = { imageWidth: 3264, imageHeight: 2448 };

let currentLevel = 0;
let currentShot = 0;
const photos = [];

let rawPitch = null;
let displayPitch = null;
let lastAngleShown = null;
let lastAligned = null;
let running = false;

let gyroActive = false;
let gotOrientation = false;
let stream = null;
let frameLoopGen = 0;
let frameSeq = 0;
let busy = false;

// Safari ships takePhoto but it reconfigures the capture session on every shot: the
// preview goes black and each still allocates a sensor-sized buffer that kills the
// tab after a handful. Canvas on iOS, real stills everywhere else.
const IS_IOS = /iP(hone|od|ad)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const USE_STILL = !IS_IOS && ("ImageCapture" in window);

let imageCapture = null;

const hasVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
let previewLabel = "…", shotLabel = "—", fpsText = "…";
let uiFrames = 0, camFrames = 0, fpsAt = 0;
let shotW = 0, shotH = 0;

const $ = (id) => document.getElementById(id);
const intro = $("intro"), capture = $("capture");
const startBtn = $("start-btn"), errorEl = $("error");
const video = $("video");
const progressFill = $("progress-fill");
const levelLabel = $("level-label"), shotCounter = $("shot-label");
const tilt = $("tilt"), bubble = $("tilt-bubble"), angleEl = $("angle");
const prompt = $("prompt");
const captureBtn = $("capture-btn"), exportBtn = $("export-btn");
const flash = $("flash"), perf = $("perf");

startBtn.addEventListener("click", async () => {
  errorEl.classList.add("hidden");
  startBtn.disabled = true;

  gyroActive = await requestGyro();

  try {
    await startCamera();
  } catch (err) {
    errorEl.textContent = "Camera error: " + err.message + " (needs an HTTPS page)";
    errorEl.classList.remove("hidden");
    startBtn.disabled = false;
    return;
  }

  if (gyroActive) {
    window.addEventListener("deviceorientation", handleOrientation);
    setTimeout(() => { if (!gotOrientation) disableTilt(); }, 2000);
  } else {
    disableTilt();
  }

  intro.classList.replace("active", "hidden");
  capture.classList.replace("hidden", "active");

  running = true;
  updateHUD();
  updatePerf();
  requestAnimationFrame(renderLoop);
});

async function requestGyro() {
  if (typeof DeviceOrientationEvent === "undefined") return false;
  if (typeof DeviceOrientationEvent.requestPermission !== "function") return true;
  try {
    return (await DeviceOrientationEvent.requestPermission()) === "granted";
  } catch (_) {
    return false;
  }
}

// Ask for ONE edge, never a width+height pair. Chrome/Android resolves a pair in
// sensor space and silently hands back a landscape crop - measured on a Xiaomi
// (Android 16), {width:exact 1440, height:exact 1920} returns 1920x1440 with no
// error, scene upright but the top and bottom gone. Constraining the short edge
// alone returns a true portrait 3:4 track. iOS honours either form, and
// applyConstraints can lower a resolution but never raise it.
//
// With a real still the preview is only a viewfinder, so ask for the lightest track
// that still comes back 3:4. Without one the photo IS a preview frame, so keep it big.
function shortEdgeLadder() {
  return USE_STILL ? [1080, 960, 1200, 1440, 1920] : [1440, 1920, 1080];
}

// A track can answer the right size with the wrong shape - {height: exact 720} came
// back 720x720 square on the Xiaomi - so check what arrived instead of trusting it.
function isPhotoShaped(s) {
  const ar = (s.width || 0) / (s.height || 1);
  return Math.abs(ar - SHOT_AR) < 0.02 || Math.abs(ar - 1 / SHOT_AR) < 0.02;
}

async function startCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;

  imageCapture = null;

  const face = { ideal: "environment" };
  let lastErr = null;
  for (const h of shortEdgeLadder()) {
    let candidate = null;
    try {
      candidate = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: face, height: { exact: h } }, audio: false
      });
    } catch (err) {
      lastErr = err;
      continue;
    }
    if (isPhotoShaped(candidate.getVideoTracks()[0].getSettings())) {
      stream = candidate;
      break;
    }
    candidate.getTracks().forEach((t) => t.stop());
  }
  if (!stream) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: face }, audio: false });
    } catch (err) {
      throw lastErr || err;
    }
  }

  video.srcObject = stream;
  const track = stream.getVideoTracks()[0];

  if (USE_STILL) {
    try { imageCapture = new ImageCapture(track); } catch (_) {}
  }

  const s2 = track.getSettings();
  previewLabel = s2.width + "×" + s2.height;
  await video.play().catch(() => {});

  startFrameLoop();
}

// Re-attaching srcObject cancels any pending requestVideoFrameCallback, so the loop
// has to be restartable. The generation token keeps a resurrected chain from running
// alongside an old one that turned out to be alive.
function startFrameLoop() {
  if (!hasVFC) return;
  const gen = ++frameLoopGen;
  const tick = () => {
    if (gen !== frameLoopGen) return;
    camFrames++;
    frameSeq++;
    video.requestVideoFrameCallback(tick);
  };
  video.requestVideoFrameCallback(tick);
}

// iOS pauses the element under memory pressure and after a backgrounding.
video.addEventListener("pause", () => { if (running) video.play().catch(() => {}); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && running) video.play().catch(() => {});
});

// Resolves true as soon as a freshly decoded frame lands, false on timeout.
function waitForFrame(ms) {
  if (!hasVFC) return new Promise((res) => setTimeout(() => res(true), 60));
  const seen = frameSeq;
  return new Promise((res) => {
    const t0 = performance.now();
    const poll = () => {
      if (frameSeq !== seen) return res(true);
      if (performance.now() - t0 >= ms) return res(false);
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
}

// After a canvas read-back WebKit sometimes drops the video compositing layer: the
// stream is still live, the element just paints black. Re-attaching srcObject hands
// it a fresh surface; only a genuinely dead track needs the session rebuilt.
async function recoverPreview() {
  if (video.paused) await video.play().catch(() => {});
  if (await waitForFrame(200)) return;

  video.srcObject = null;
  video.srcObject = stream;
  await video.play().catch(() => {});
  startFrameLoop();
  if (await waitForFrame(500)) return;

  try { await startCamera(); } catch (_) {}
}

function disableTilt() {
  gyroActive = false;
  window.removeEventListener("deviceorientation", handleOrientation);
  tilt.classList.add("hidden");
  captureBtn.classList.add("ready");
  updateHUD();
}

function handleOrientation(e) {
  if (e.beta == null) return;
  gotOrientation = true;
  // Flip to (90 - e.beta) if pitch is inverted on your device.
  rawPitch = e.beta - 90;
}

function renderLoop(now) {
  if (!running) return;
  if (gyroActive && rawPitch !== null) {
    displayPitch = (displayPitch === null)
        ? rawPitch
        : displayPitch + (rawPitch - displayPitch) * SMOOTHING;
    updateTilt(displayPitch);
  }

  uiFrames++;
  if (!fpsAt) fpsAt = now;
  if (now - fpsAt >= 1000) {
    fpsText = String(hasVFC ? camFrames : uiFrames);
    uiFrames = camFrames = 0;
    fpsAt = now;
    updatePerf();
  }

  requestAnimationFrame(renderLoop);
}

function updatePerf() {
  perf.textContent = "FPS " + fpsText + " · Preview " + previewLabel + " · Shot " + shotLabel;
}

function fmtSize(bytes) {
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + "MB" : Math.round(bytes / 1024) + "KB";
}

function updateTilt(pitch) {
  const target = LEVEL_TARGETS[currentLevel];
  const diff = pitch - target;

  const half = 97;
  const clamped = Math.max(-RANGE, Math.min(RANGE, diff));
  const offset = -(clamped / RANGE) * half;
  bubble.style.transform = `translate(-50%, calc(-50% + ${offset.toFixed(1)}px))`;

  const deg = Math.round(pitch);
  if (deg !== lastAngleShown) {
    angleEl.textContent = (deg > 0 ? "+" : "") + deg + "°";
    lastAngleShown = deg;
  }

  const aligned = Math.abs(diff) <= TOLERANCE;
  if (aligned !== lastAligned) {
    tilt.classList.toggle("aligned", aligned);
    captureBtn.classList.toggle("ready", aligned);
    lastAligned = aligned;
  }
}

function updateHUD() {
  const done = currentLevel * SHOTS_PER_LEVEL + currentShot;
  progressFill.style.width = (done / TOTAL_SHOTS) * 100 + "%";

  if (done >= TOTAL_SHOTS) {
    levelLabel.textContent = "Done";
    shotCounter.textContent = photos.length + " photos";
    prompt.textContent = "All set. Download the pack below.";
    captureBtn.classList.add("hidden");
    exportBtn.classList.remove("hidden");
    tilt.classList.add("hidden");
    return;
  }

  const t = LEVEL_TARGETS[currentLevel];
  const tiltText = `${t > 0 ? "+" : ""}${t}°`;
  levelLabel.textContent = `Level ${currentLevel + 1} of 5 (${tiltText})`;
  shotCounter.textContent = `Shot ${currentShot + 1} of 8`;
  prompt.textContent = currentShot === 0
      ? (gyroActive ? `Tilt the phone to ${tiltText}` : `Aim ~${tiltText} (no sensor)`)
      : "Rotate ~45° right" + (gyroActive ? " and align" : "");
}

// Read the JPEG frame header rather than decoding: createImageBitmap on an 8MP still,
// forty times over, is the allocation pattern that kills a mobile tab.
async function jpegSize(blob) {
  try {
    const b = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  } catch (_) {}
  return null;
}

// One reused canvas. Resize only when the frame size changes (realloc leaks on iOS).
const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d");

async function capturePhoto() {
  if (imageCapture) {
    try {
      const blob = await imageCapture.takePhoto(STILL_SETTINGS);
      // takePhoto drops the compositing layer on Android too, same as the canvas grab.
      await recoverPreview();
      // STILL_SETTINGS is a request, not a promise: a device that ignores it can
      // hand back its 16:9 default. Checking beats shipping a pack of mixed shapes.
      const d = await jpegSize(blob);
      if (!d || isPhotoShaped({ width: d.w, height: d.h })) {
        shotW = d ? d.w : 0;
        shotH = d ? d.h : 0;
        return blob;
      }
      imageCapture = null; // wrong shape: the canvas crops reliably, use it instead
    } catch (_) {
      imageCapture = null; // one strike: canvas for the rest of the run
    }
  }

  // Never grab a stale frame: mid-recovery the preview draws black.
  if (video.paused) await video.play().catch(() => {});
  await waitForFrame(400);

  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;

  // Target orientation comes from the SCREEN, not the frame. The preview is a fixed
  // 3:4 box using object-fit: cover, so deriving the crop the same way keeps what you
  // see and what is saved identical even if a driver hands back a landscape track.
  const ar = (window.innerHeight >= window.innerWidth) ? SHOT_AR : 1 / SHOT_AR;
  let sw = vw, sh = vh;
  if (vw / vh > ar) sw = Math.round(vh * ar);
  else sh = Math.round(vw / ar);
  const sx = Math.round((vw - sw) / 2);
  const sy = Math.round((vh - sh) / 2);

  // Cap the long edge, then derive the short one so the ratio stays exact.
  const scale = Math.min(1, LONG_EDGE / Math.max(sw, sh));
  let w, h;
  if (sh >= sw) { h = Math.round(sh * scale); w = Math.round(h * ar); }
  else { w = Math.round(sw * scale); h = Math.round(w / ar); }

  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  shotW = w;
  shotH = h;

  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", JPEG_QUALITY));
  await recoverPreview();
  return blob;
}

captureBtn.addEventListener("click", async () => {
  if (busy || currentLevel >= LEVEL_TARGETS.length) return;
  busy = true;

  flash.classList.add("animate");
  setTimeout(() => flash.classList.remove("animate"), 180);

  captureBtn.disabled = true;
  let blob = null;
  try {
    blob = await capturePhoto();
  } catch (_) {}
  captureBtn.disabled = false;
  busy = false;

  if (!blob) {
    prompt.textContent = "Frame dropped - tap again.";
    return;
  }

  // Size from the blob directly - no createImageBitmap (that bitmap leaked memory on iOS).
  shotLabel = (shotW ? shotW + "×" + shotH + " " : "") + "(" + fmtSize(blob.size) + ")";
  updatePerf();

  photos.push({ level: currentLevel, shot: currentShot, blob });

  currentShot++;
  if (currentShot >= SHOTS_PER_LEVEL) {
    currentShot = 0;
    currentLevel++;
  }
  updateHUD();
});

exportBtn.addEventListener("click", async () => {
  exportBtn.disabled = true;
  exportBtn.textContent = "Packing…";
  try {
    const zip = new JSZip();
    const folder = zip.folder("360_photos");
    for (const p of photos) {
      const l = String(p.level + 1).padStart(2, "0");
      const s = String(p.shot + 1).padStart(2, "0");
      folder.file(`level_${l}_shot_${s}.jpg`, p.blob);
    }
    // STORE, not DEFLATE: JPEGs do not compress, and deflating 40 of them in one
    // pass is enough on its own to push mobile Safari over its memory limit.
    const content = await zip.generateAsync({ type: "blob", compression: "STORE" });
    const url = URL.createObjectURL(content);
    const a = document.createElement("a");
    a.href = url;
    a.download = "360_photos.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    exportBtn.textContent = "Downloaded!";
  } catch (err) {
    alert("Failed to build ZIP: " + err.message);
    exportBtn.disabled = false;
    exportBtn.textContent = "Download all 40 photos (.zip)";
  }
});
