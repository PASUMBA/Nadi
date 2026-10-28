import { estimateBpm, pos, resample } from "./rppg.js";

const MEDIAPIPE_VERSION = "0.10.14";
const VISION_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const ROI_INDICES = [
  [109, 10, 338, 337, 336, 285, 8, 55, 107, 108],
  [116, 117, 118, 100, 126, 142, 203, 206, 207, 187, 147, 123],
  [345, 346, 347, 329, 355, 371, 423, 426, 427, 411, 376, 352],
];
const ROI_COLORS = ["#7ce0c3", "#ffc977", "#92baff"];
const SAMPLE_RATE = 30;
const WINDOW_SECONDS = 10;
const BUFFER_SECONDS = 12;
const MIN_SNR_DB = 3;

const video = document.querySelector("#video");
const overlay = document.querySelector("#overlay");
const startButton = document.querySelector("#toggle");
const bpmOutput = document.querySelector("#bpm");
const status = document.querySelector("#status");
const cameraMessage = document.querySelector("#camera-message");
const overlayContext = overlay.getContext("2d");
const sampleCanvas = document.createElement("canvas");
const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
const maskCanvas = document.createElement("canvas");
const maskContext = maskCanvas.getContext("2d");

let landmarkerPromise;
let landmarker;
let stream;
let running = false;
let frameRequest;
let frameRequestType;
let samples = [];
let estimates = [];
let firstSampleTime;
let lastEstimateTime = -Infinity;
let latestSnr = -Infinity;

async function createLandmarker() {
  const { FaceLandmarker, FilesetResolver } = await import(`${VISION_CDN}/vision_bundle.mjs`);
  const vision = await FilesetResolver.forVisionTasks(`${VISION_CDN}/wasm`);
  const options = {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    numFaces: 1,
  };
  try {
    return await FaceLandmarker.createFromOptions(vision, options);
  } catch (gpuError) {
    return FaceLandmarker.createFromOptions(vision, {
      ...options,
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
    });
  }
}

function startFrameLoop() {
  if (!running) return;
  if (typeof video.requestVideoFrameCallback === "function") {
    frameRequestType = "video";
    frameRequest = video.requestVideoFrameCallback(processFrame);
  } else {
    frameRequestType = "animation";
    frameRequest = requestAnimationFrame(processFrame);
  }
}

function clearMeasurement() {
  samples = [];
  estimates = [];
  firstSampleTime = undefined;
  lastEstimateTime = -Infinity;
  latestSnr = -Infinity;
  delete status.dataset.snr;
  bpmOutput.value = "--";
  bpmOutput.textContent = "--";
  bpmOutput.classList.remove("low-confidence");
}

function setCanvasSizes() {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return;
  overlay.width = width;
  overlay.height = height;
  const processingWidth = Math.min(640, width);
  const processingHeight = Math.round((height * processingWidth) / width);
  sampleCanvas.width = processingWidth;
  sampleCanvas.height = processingHeight;
  maskCanvas.width = processingWidth;
  maskCanvas.height = processingHeight;
}

function drawAndMeasure(landmarks) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;
  setCanvasSizes();
  overlayContext.clearRect(0, 0, width, height);
  sampleContext.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);
  maskContext.clearRect(0, 0, maskCanvas.width, maskCanvas.height);

  const polygons = ROI_INDICES.map((indices) =>
    indices.map((index) => {
      const point = landmarks[index];
      return [point.x * sampleCanvas.width, point.y * sampleCanvas.height];
    }),
  );

  for (let region = 0; region < polygons.length; region += 1) {
    const polygon = polygons[region];
    overlayContext.beginPath();
    polygon.forEach(([x, y], index) => {
      const canvasX = (x / sampleCanvas.width) * width;
      const canvasY = (y / sampleCanvas.height) * height;
      if (index === 0) overlayContext.moveTo(canvasX, canvasY);
      else overlayContext.lineTo(canvasX, canvasY);
    });
    overlayContext.closePath();
    overlayContext.strokeStyle = ROI_COLORS[region];
    overlayContext.lineWidth = Math.max(2, width / 420);
    overlayContext.fillStyle = `${ROI_COLORS[region]}33`;
    overlayContext.fill();
    overlayContext.stroke();

    maskContext.beginPath();
    polygon.forEach(([x, y], index) => {
      if (index === 0) maskContext.moveTo(x, y);
      else maskContext.lineTo(x, y);
    });
    maskContext.closePath();
    maskContext.fillStyle = "#ffffff";
    maskContext.fill();
  }

  const pixels = sampleContext.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
  const mask = maskContext.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
  const totals = [0, 0, 0];
  let count = 0;
  for (let pixel = 0; pixel < mask.length; pixel += 4) {
    if (mask[pixel + 3] === 0) continue;
    totals[0] += pixels[pixel];
    totals[1] += pixels[pixel + 1];
    totals[2] += pixels[pixel + 2];
    count += 1;
  }
  if (!count) return null;
  return totals.map((channel) => channel / count);
}

function updateEstimate(now) {
  samples = samples.filter(([time]) => now - time <= BUFFER_SECONDS * 1000);
  if (firstSampleTime === undefined) firstSampleTime = now;
  const elapsed = (now - firstSampleTime) / 1000;

  if (elapsed < WINDOW_SECONDS) {
    status.textContent = `Measuring… ${Math.ceil(WINDOW_SECONDS - elapsed)} s`;
    return;
  }
  if (now - lastEstimateTime < 1000 || samples.length < 2) return;

  const uniform = resample(
    samples.map(([time]) => time),
    samples.map(([, color]) => color),
    SAMPLE_RATE,
  );
  const signal = pos(uniform.slice(-WINDOW_SECONDS * SAMPLE_RATE), SAMPLE_RATE);
  const result = estimateBpm(signal, SAMPLE_RATE);
  if (!Number.isFinite(result.bpm) || !Number.isFinite(result.snr)) return;

  latestSnr = result.snr;
  status.dataset.snr = latestSnr.toFixed(2);
  estimates.push(result.bpm);
  if (estimates.length > 5) estimates.shift();
  const sorted = [...estimates].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  bpmOutput.value = String(Math.round(median));
  bpmOutput.textContent = String(Math.round(median));
  bpmOutput.classList.toggle("low-confidence", latestSnr < MIN_SNR_DB);
  status.textContent =
    latestSnr < MIN_SNR_DB ? "Hold still / improve lighting" : "Measuring";
  lastEstimateTime = now;
}

function processFrame(now) {
  if (!running) return;
  try {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const result = landmarker.detectForVideo(video, now);
      const face = result.faceLandmarks?.[0];
      if (!face) {
        clearMeasurement();
        overlayContext.clearRect(0, 0, overlay.width, overlay.height);
        status.textContent = "No face found";
      } else {
        cameraMessage.hidden = true;
        const color = drawAndMeasure(face);
        if (color) {
          if (firstSampleTime === undefined) firstSampleTime = now;
          samples.push([now, color]);
          updateEstimate(now);
        }
      }
    }
  } catch (error) {
    console.error("Frame processing failed", error);
    status.textContent = "Camera processing stopped";
    stopCamera();
    return;
  }
  startFrameLoop();
}

async function startCamera() {
  startButton.disabled = true;
  status.textContent = "Requesting camera…";
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
        facingMode: "user",
      },
    });
    video.srcObject = stream;
    await video.play();
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise((resolve) => video.addEventListener("loadedmetadata", resolve, { once: true }));
    }
    setCanvasSizes();
    cameraMessage.hidden = false;
    status.textContent = "Loading face detector…";
    landmarkerPromise ??= createLandmarker();
    landmarker = await landmarkerPromise;
    if (!running) return;
    clearMeasurement();
    cameraMessage.hidden = true;
    startButton.textContent = "Stop";
    status.textContent = "Looking for your face…";
    startFrameLoop();
  } catch (error) {
    console.error("Unable to start camera", error);
    status.textContent =
      error.name === "NotAllowedError"
        ? "Allow camera access to measure"
        : "Camera or face detector unavailable";
    running = false;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    startButton.textContent = "Start";
  } finally {
    startButton.disabled = false;
  }
}

function stopCamera() {
  running = false;
  if (frameRequestType === "video" && frameRequest !== undefined) {
    video.cancelVideoFrameCallback(frameRequest);
  } else if (frameRequest !== undefined) {
    cancelAnimationFrame(frameRequest);
  }
  frameRequest = undefined;
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  video.srcObject = null;
  overlayContext.clearRect(0, 0, overlay.width, overlay.height);
  cameraMessage.hidden = false;
  startButton.textContent = "Start";
  status.textContent = "Camera is off";
  clearMeasurement();
}

startButton.addEventListener("click", () => {
  if (running) {
    stopCamera();
    return;
  }
  running = true;
  startCamera();
});
