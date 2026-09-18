"use strict";

const LEVEL_TARGETS = [60, 30, 0, -30, -60];
const SHOTS_PER_LEVEL = 8;
const TOTAL_SHOTS = LEVEL_TARGETS.length * SHOTS_PER_LEVEL;

const TOLERANCE = 5;
const RANGE = 25;
const SMOOTHING = 0.18;

// Rotation between shots. The tolerance is looser than TOLERANCE because 45 degree
// sectors want overlap, and a few degrees of slop costs nothing in the final set.
const YAW_STEP = 45;
const YAW_TOLERANCE = 8;
const YAW_RANGE = 45;   // the gauge spans one full step: just-shot at the end, target at the centre
const ROTATION_SIGN = 1; // flip to -1 if "rotate right" drives the bubble away from the centre
const DEG = Math.PI / 180;

const DOME_PX = 112;    // keep in sync with .dome in style.css

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

let rawYaw = null;
let displayYaw = null;
let levelStartYaw = null;   // yaw reference, re-zeroed on the first shot of every level
let lastSpinShown = null;
let lastSpinAligned = null;

// The shutter ring now answers to both axes, so each one keeps its own verdict.
let tiltAligned = false;
let spinAligned = false;
let lastReady = null;

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
const dome = $("dome");
const spin = $("spin"), spinBubble = $("spin-bubble"), spinDeg = $("spin-deg");
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
  initDome();
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

function normDeg(d) {
  return ((d % 360) + 360) % 360;
}

// Shortest signed distance from b to a, in [-180, 180). Plain subtraction turns the
// 359 -> 1 wrap into a 358 degree jump, which shows up as the bubble flying across
// the track and as a 359 degree lerp in the smoothing.
function angleDiff(a, b) {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

// Never read e.alpha directly. deviceorientation is Euler ZXY, and alpha/gamma go
// degenerate at beta = +-90 - which, given rawPitch = e.beta - 90 below, is exactly
// LEVEL_TARGETS' 0 degree level. Raw alpha would hand back a yaw that jumps around
// on the middle level of the run. Rebuilding R = Rz(a)Rx(b)Ry(g) and taking the
// azimuth of the rear camera axis (the device -z) steps around that: the noise in
// alpha and gamma largely cancels on recomposition, and across +60..-60 the vector's
// horizontal component never drops below cos 60, so the azimuth stays well behaved.
function cameraHeading(alpha, beta, gamma) {
  const cA = Math.cos(alpha * DEG), sA = Math.sin(alpha * DEG);
  const sB = Math.sin(beta * DEG); // so o seno entra em m13/m23
  const cG = Math.cos(gamma * DEG), sG = Math.sin(gamma * DEG);
  // third column of R: the device +z axis in world coords (X east, Y north, Z up)
  const m13 = cA * sG + sA * sB * cG;
  const m23 = sA * sG - cA * sB * cG;
  return normDeg(Math.atan2(-m13, -m23) / DEG);
}

function disableTilt() {
  gyroActive = false;
  window.removeEventListener("deviceorientation", handleOrientation);
  tilt.classList.add("hidden");
  spin.classList.add("hidden");
  // No sensor, no verdict to give: the shutter stays lit, and the dome carries on as a
  // plain progress map minus the live cursor.
  tiltAligned = spinAligned = true;
  refreshReady();
  updateHUD();
}

function handleOrientation(e) {
  if (e.beta == null) return;
  gotOrientation = true;
  // Flip to (90 - e.beta) if pitch is inverted on your device.
  rawPitch = e.beta - 90;
  if (e.alpha != null && e.gamma != null) rawYaw = cameraHeading(e.alpha, e.beta, e.gamma);
}

function renderLoop(now) {
  if (!running) return;
  if (gyroActive && rawPitch !== null) {
    displayPitch = (displayPitch === null)
        ? rawPitch
        : displayPitch + (rawPitch - displayPitch) * SMOOTHING;
    updateTilt(displayPitch);
  }

  if (gyroActive && rawYaw !== null) {
    // Same smoothing as the pitch, but stepped through angleDiff so it takes the
    // short way around instead of unwinding the whole circle at the wrap.
    displayYaw = (displayYaw === null)
        ? rawYaw
        : normDeg(displayYaw + angleDiff(rawYaw, displayYaw) * SMOOTHING);
    if (levelStartYaw === null) levelStartYaw = displayYaw;
    updateSpin();
  }
  drawDome();

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
    tiltAligned = aligned;
    refreshReady();
    lastAligned = aligned;
  }
}

// Both axes have to agree before the shutter goes green. Advisory only - the button
// never blocks, same as before, because a drifting sensor must not be able to stop
// the run.
function refreshReady() {
  const ready = tiltAligned && spinAligned;
  if (ready === lastReady) return;
  captureBtn.classList.toggle("ready", ready);
  lastReady = ready;
}

// Measured from the start of the LEVEL, not from the previous shot: overshooting one
// step then leaves the next target still on the ideal grid, instead of dragging the
// whole 8-shot pattern along with the error.
function spinTarget() {
  return levelStartYaw === null ? null : levelStartYaw + ROTATION_SIGN * YAW_STEP * currentShot;
}

function updateSpin() {
  const target = spinTarget();
  if (target === null || displayYaw === null || currentShot === 0) {
    // First shot of a level is the reference - there is no rotation to satisfy yet.
    if (!spinAligned) { spinAligned = true; refreshReady(); }
    lastSpinAligned = null;
    return;
  }

  const diff = angleDiff(displayYaw, target);

  const half = 97;
  const clamped = Math.max(-YAW_RANGE, Math.min(YAW_RANGE, diff));
  const offset = (clamped / YAW_RANGE) * half;
  spinBubble.style.transform = `translate(calc(-50% + ${offset.toFixed(1)}px), -50%)`;

  const deg = Math.round(-diff * ROTATION_SIGN); // degrees still to go, counting down to 0
  if (deg !== lastSpinShown) {
    spinDeg.textContent = (deg > 0 ? "+" : "") + deg + "\u00b0";
    lastSpinShown = deg;
  }

  const aligned = Math.abs(diff) <= YAW_TOLERANCE;
  if (aligned !== lastSpinAligned) {
    spin.classList.toggle("aligned", aligned);
    spinAligned = aligned;
    refreshReady();
    lastSpinAligned = aligned;
  }
}

// Coverage dome: LEVEL_TARGETS.length rings x SHOTS_PER_LEVEL sectors, seen from above.
// The 40 cells only change when a photo lands, so they live on their own canvas and the
// per-frame work is one blit plus the cursor - drawing 40 arcs at 60fps would be waste
// in an app that puts its own frame rate on screen.
const domeBase = document.createElement("canvas");
const domeBaseCtx = domeBase.getContext("2d");
const domeCtx = dome.getContext("2d");
let domeR = 0, domeMid = 0, domeScale = 1;
let domeDirty = true, domeCursor = "";
const domeInk = { accent: "#4c8dff", ok: "#34d17a" };

function initDome() {
  domeScale = Math.min(window.devicePixelRatio || 1, 3);
  const px = Math.round(DOME_PX * domeScale);
  dome.width = domeBase.width = px;
  dome.height = domeBase.height = px;
  domeMid = px / 2;
  domeR = domeMid - 2 * domeScale; // room for the outer ring stroke

  // Single-source the palette: these are the same tokens style.css paints with.
  const cs = getComputedStyle(document.documentElement);
  domeInk.accent = cs.getPropertyValue("--accent").trim() || domeInk.accent;
  domeInk.ok = cs.getPropertyValue("--ok").trim() || domeInk.ok;

  drawDomeBase();
}

function cellPath(ctx, level, sector) {
  const step = 360 / SHOTS_PER_LEVEL;
  const r0 = domeR * level / LEVEL_TARGETS.length;
  const r1 = domeR * (level + 1) / LEVEL_TARGETS.length;
  const a0 = (sector * step - 90 - step / 2) * DEG; // sector 0 centred at the top
  const a1 = a0 + step * DEG;
  ctx.beginPath();
  ctx.arc(domeMid, domeMid, r1, a0, a1);
  ctx.arc(domeMid, domeMid, r0, a1, a0, true);
  ctx.closePath();
}

function drawDomeBase() {
  if (!domeR) return;
  const ctx = domeBaseCtx;
  ctx.clearRect(0, 0, domeBase.width, domeBase.height);

  // Capture is sequential, so the filled cells are always the first `done` in order.
  const done = currentLevel * SHOTS_PER_LEVEL + currentShot;
  for (let level = 0; level < LEVEL_TARGETS.length; level++) {
    for (let sector = 0; sector < SHOTS_PER_LEVEL; sector++) {
      const idx = level * SHOTS_PER_LEVEL + sector;
      const isTarget = idx === done;
      cellPath(ctx, level, sector);
      if (idx < done) {
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = domeInk.accent;
      } else {
        ctx.globalAlpha = 1;
        ctx.fillStyle = "rgba(255,255,255,0.07)";
      }
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = (isTarget ? 2 : 1) * domeScale;
      ctx.strokeStyle = isTarget ? domeInk.ok : "rgba(255,255,255,0.22)";
      ctx.stroke();
    }
  }
  domeDirty = true;
}

function drawDome() {
  if (!domeR) return;

  // (75 - pitch) / 150 lands each LEVEL_TARGETS entry on the CENTRE of its ring
  // (+60 -> 0.1, 0 -> 0.5, -60 -> 0.9) rather than on the seam between two rings.
  const live = gyroActive && displayPitch !== null && displayYaw !== null && levelStartYaw !== null;
  let x = 0, y = 0, key = "";
  if (live) {
    const r = Math.max(0, Math.min(1, (75 - displayPitch) / 150)) * domeR;
    const a = (ROTATION_SIGN * angleDiff(displayYaw, levelStartYaw) - 90) * DEG;
    x = domeMid + r * Math.cos(a);
    y = domeMid + r * Math.sin(a);
    key = Math.round(x) + ":" + Math.round(y);
  }
  if (!domeDirty && key === domeCursor) return;
  domeDirty = false;
  domeCursor = key;

  domeCtx.clearRect(0, 0, dome.width, dome.height);
  domeCtx.drawImage(domeBase, 0, 0);
  if (!live) return;

  domeCtx.beginPath();
  domeCtx.arc(x, y, 4 * domeScale, 0, Math.PI * 2);
  domeCtx.fillStyle = "#fff";
  domeCtx.fill();
  domeCtx.lineWidth = 2 * domeScale;
  domeCtx.strokeStyle = "rgba(0,0,0,0.55)";
  domeCtx.stroke();
}

function updateHUD() {
  const done = currentLevel * SHOTS_PER_LEVEL + currentShot;
  progressFill.style.width = (done / TOTAL_SHOTS) * 100 + "%";
  drawDomeBase();

  if (done >= TOTAL_SHOTS) {
    levelLabel.textContent = "Done";
    shotCounter.textContent = photos.length + " photos";
    prompt.textContent = "All set. Download the pack below.";
    captureBtn.classList.add("hidden");
    exportBtn.classList.remove("hidden");
    tilt.classList.add("hidden");
    spin.classList.add("hidden");
    return;
  }

  const t = LEVEL_TARGETS[currentLevel];
  const tiltText = `${t > 0 ? "+" : ""}${t}°`;
  levelLabel.textContent = `Level ${currentLevel + 1} of 5 (${tiltText})`;
  shotCounter.textContent = `Shot ${currentShot + 1} of 8`;
  prompt.textContent = currentShot === 0
      ? (gyroActive ? `Tilt the phone to ${tiltText}` : `Aim ~${tiltText} (no sensor)`)
      : (gyroActive ? "Rotate right until the bar centres" : "Rotate ~45° right (no sensor)");

  spin.classList.toggle("hidden", !gyroActive || currentShot === 0);
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

  // The first shot of a level IS the rotation reference, so zero it here: drift only
  // ever accumulates within one level (~1 min) instead of across the whole run.
  if (currentShot === 0 && rawYaw !== null) levelStartYaw = rawYaw;

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
