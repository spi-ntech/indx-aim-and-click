import {
  createCalibrationMatrix, IMAGE_HEIGHT, IMAGE_WIDTH, imagePointFromClient, imagePointToClient,
  isPointInCentralRegion, movementToReference, nudgePoint
} from './calibration-core.js';
import { IndxAdapter } from './indx-adapter.js?v=20260922-1';

const elements = Object.fromEntries([
  'viewer','stream','referenceSafeZone','marker','referenceCrosshair','message','status','position','calData',
  'prepareT0','confirmCenter','pointPanel','jogPanel','clearCalibration','save','toolGuide','confirmPoint','cancelPoint','toolButtons',
  'zoomButton','displayButton','displayReset','displayPopover','brightness','contrast','gamma','crosshairSize','markerSize',
  'brightnessValue','contrastValue','gammaValue','crosshairSizeValue','markerSizeValue','gammaR','gammaG','gammaB',
  'targetX','targetY','targetZ','loadCurrentPosition','moveToPosition','jogLockReason','centerStep','referenceStep','toolsStep',
  'cameraSelect','emergencyStop','undoStep','offsetRows'
].map(id => [id, document.getElementById(id)]));
const query = new URLSearchParams(location.search);
const adapter = new IndxAdapter(globalThis.fetch.bind(globalThis), query.get('moonraker') || '');
const cameraOverride = query.get('camera');

const referenceKey = 'indxPublicCamReferenceV1';
const matrixKey = 'indxPublicCamMatrixV1';
const completedToolsKey = 'indxPublicCamCompletedToolsV1';
const selectedCameraKey = 'indxAimClickSelectedCameraV1';
let reference = JSON.parse(localStorage.getItem(referenceKey) || 'null');
let matrix = JSON.parse(localStorage.getItem(matrixKey) || 'null');
let completedTools = new Set(JSON.parse(localStorage.getItem(completedToolsKey) || '[]').map(Number).filter(Number.isInteger));
let selectedCameraName = localStorage.getItem(selectedCameraKey) || '';
let webcams = [];
let stage = 'idle';
let xPoint = null;
let pendingPoint = null;
let calibrationTool = null;
let unsavedTool = null;
let lastConfirmedCorrection = null;
let renderedToolCount = null;
let toolRangeLabel = 'T1–T?';
let busy = false;
let t0Prepared = false;
let centerConfirmed = !!reference;
let axisDistance = 1;
let latestState = null;
const stepExpansionOverrides = new Map();
const zoomLevels = [1, 1.5, 2, 3];
let zoomIndex = 0;
const displaySettingsKey = 'indxCamDisplaySettingsV2';
const savedDisplaySettings = JSON.parse(localStorage.getItem(displaySettingsKey) || 'null');
if (savedDisplaySettings) {
  for (const key of ['brightness','contrast','gamma','crosshairSize','markerSize']) {
    if (Number.isFinite(Number(savedDisplaySettings[key]))) elements[key].value = savedDisplaySettings[key];
  }
}

function appState() {
  return {version:1,reference,matrix,completedTools:[...completedTools].sort((a,b)=>a-b),selectedCameraName};
}

function persistAppState() {
  localStorage.setItem(referenceKey, JSON.stringify(reference));
  localStorage.setItem(matrixKey, JSON.stringify(matrix));
  localStorage.setItem(completedToolsKey, JSON.stringify([...completedTools].sort((a,b)=>a-b)));
  localStorage.setItem(selectedCameraKey, selectedCameraName);
  adapter.saveAppState(appState()).catch(() => {});
}

async function restoreAppState() {
  try {
    const saved = await adapter.loadAppState();
    if (!saved || saved.version !== 1) return;
    if (saved.reference) { reference = saved.reference; centerConfirmed = true; }
    if (saved.matrix) matrix = saved.matrix;
    if (Array.isArray(saved.completedTools)) completedTools = new Set(saved.completedTools.filter(Number.isInteger));
    if (typeof saved.selectedCameraName === 'string') selectedCameraName = saved.selectedCameraName;
  } catch (_error) { /* local storage remains the offline fallback */ }
}

function cameraStreamUrl(webcam) {
  return webcam?.streamUrl || cameraOverride || '/webcam/?action=stream';
}

function applySelectedCamera() {
  const webcam = webcams.find(item => item.name === selectedCameraName);
  const url = cameraStreamUrl(webcam);
  if (elements.stream.src !== new URL(url, location.href).href) elements.stream.src = url;
}

async function loadWebcams() {
  if (cameraOverride) {
    elements.cameraSelect.replaceChildren(new Option('URL override', cameraOverride));
    elements.cameraSelect.disabled = true;
    elements.stream.src = cameraOverride;
    return;
  }
  try { webcams = await adapter.listWebcams(); } catch (_error) { webcams = []; }
  elements.cameraSelect.replaceChildren();
  if (!webcams.length) {
    elements.cameraSelect.append(new Option('Default webcam', ''));
    selectedCameraName = '';
  } else {
    for (const webcam of webcams) elements.cameraSelect.append(new Option(webcam.name, webcam.name));
    if (!webcams.some(item => item.name === selectedCameraName)) selectedCameraName = webcams[0].name;
    elements.cameraSelect.value = selectedCameraName;
  }
  applySelectedCamera();
  persistAppState();
}

function renderCameraDisplay() {
  updateMarkerSizeLimit();
  const zoom = zoomLevels[zoomIndex];
  elements.stream.style.width = `${zoom * 100}%`;
  elements.stream.style.height = `${zoom * 100}%`;
  elements.zoomButton.textContent = `${zoom * 100}%`;
  const brightness = Number(elements.brightness.value);
  const contrast = Number(elements.contrast.value);
  const gamma = Number(elements.gamma.value) / 100;
  const crosshairSize = Number(elements.crosshairSize.value);
  const markerSize = Number(elements.markerSize.value);
  const gammaExponent = (1/gamma).toFixed(3);
  [elements.gammaR,elements.gammaG,elements.gammaB].forEach(channel => channel.setAttribute('exponent', gammaExponent));
  elements.stream.style.filter = `brightness(${brightness}%) contrast(${contrast}%) url(#cameraGamma)`;
  elements.brightnessValue.textContent = `${brightness}%`;
  elements.contrastValue.textContent = `${contrast}%`;
  elements.gammaValue.textContent = gamma.toFixed(2);
  elements.crosshairSizeValue.textContent = `${crosshairSize} px`;
  elements.markerSizeValue.textContent = `${markerSize} px`;
  elements.referenceCrosshair.style.setProperty('--crosshair-size', `${crosshairSize}px`);
  elements.marker.style.setProperty('--marker-size', `${markerSize}px`);
  localStorage.setItem(displaySettingsKey, JSON.stringify({brightness,contrast,gamma:Number(elements.gamma.value),crosshairSize,markerSize}));
  renderCalibration();
}

function updateMarkerSizeLimit() {
  const shortSide = Math.min(elements.viewer.clientWidth, elements.viewer.clientHeight);
  if (!shortSide) return;
  const step = Number(elements.markerSize.step) || 1;
  const minimum = Number(elements.markerSize.min) || step;
  const maximum = Math.max(minimum, Math.floor(shortSide * 0.8 / step) * step);
  elements.markerSize.max = String(maximum);
  if (Number(elements.markerSize.value) > maximum) elements.markerSize.value = String(maximum);
}

elements.zoomButton.onclick = event => { event.stopPropagation(); zoomIndex = (zoomIndex + 1) % zoomLevels.length; renderCameraDisplay(); };
elements.displayButton.onclick = event => { event.stopPropagation(); elements.displayPopover.hidden = !elements.displayPopover.hidden; };
elements.displayPopover.onclick = event => event.stopPropagation();
[elements.brightness,elements.contrast,elements.gamma,elements.crosshairSize,elements.markerSize].forEach(input => { input.oninput = renderCameraDisplay; });
elements.displayReset.onclick = event => {
  event.stopPropagation(); zoomIndex = 0;
  elements.brightness.value = 100; elements.contrast.value = 100; elements.gamma.value = 100;
  elements.crosshairSize.value = 80; elements.markerSize.value = 18;
  renderCameraDisplay();
};
document.addEventListener('click', event => { if (!elements.displayPopover.contains(event.target) && event.target !== elements.displayButton) elements.displayPopover.hidden = true; });
new ResizeObserver(() => renderCameraDisplay()).observe(elements.viewer);

function say(text, kind='normal') {
  elements.message.textContent = text;
  elements.message.style.borderColor = kind === 'error' ? 'var(--danger)' : kind === 'ok' ? 'var(--ok)' : 'var(--accent)';
}

function imageSize() {
  return {
    width: elements.stream.naturalWidth || IMAGE_WIDTH,
    height: elements.stream.naturalHeight || IMAGE_HEIGHT
  };
}

async function locked(operation) {
  if (busy) throw new Error('Another operation is still running.');
  busy = true;
  try { return await operation(); }
  finally { busy = false; }
}

function pointCss(point) {
  const viewerRect = elements.viewer.getBoundingClientRect();
  const {width,height} = imageSize();
  const client = imagePointToClient(point, elements.stream.getBoundingClientRect(), width, height);
  // Absolute children start at the padding edge, not the outer border edge.
  return { x: client.x - viewerRect.left - elements.viewer.clientLeft,
    y: client.y - viewerRect.top - elements.viewer.clientTop };
}

function place(element, point) {
  const css = pointCss(point);
  element.style.left = `${css.x}px`;
  element.style.top = `${css.y}px`;
}

function renderReferenceSafeZone() {
  if (!t0Prepared || centerConfirmed || reference) {
    elements.referenceSafeZone.style.display = 'none';
    return;
  }
  const {width,height} = imageSize();
  const topLeft = pointCss({x:width * 0.3, y:height * 0.3});
  const bottomRight = pointCss({x:width * 0.7, y:height * 0.7});
  Object.assign(elements.referenceSafeZone.style, {
    display:'block', left:`${topLeft.x}px`, top:`${topLeft.y}px`,
    width:`${bottomRight.x-topLeft.x}px`, height:`${bottomRight.y-topLeft.y}px`
  });
}

function clearPendingPoint() {
  pendingPoint = null;
  elements.marker.style.display = 'none';
  elements.confirmPoint.disabled = true;
  elements.cancelPoint.disabled = stage !== 'captureX' && stage !== 'captureY' && lastConfirmedCorrection === null;
  document.querySelectorAll('.marker-nudge').forEach(button => { button.disabled = true; });
}

function confirmDiscardUnsavedTool(destination) {
  if (unsavedTool === null) return true;
  const discard = window.confirm(`T${unsavedTool} XY correction has not been saved.\n\nContinue to ${destination} and discard it?`);
  if (discard) unsavedTool = null;
  return discard;
}

function renderCalibration() {
  renderReferenceSafeZone();
  const axisCaptureActive = stage === 'captureX' || stage === 'captureY';
  const centerComplete = centerConfirmed || !!reference;
  const referenceComplete = !!matrix;
  const toolsComplete = referenceComplete && Number.isInteger(renderedToolCount) && renderedToolCount > 1
    && Array.from({length:renderedToolCount-1},(_,index) => index+1).every(tool => completedTools.has(tool));
  const showMachineJog = t0Prepared && !centerComplete && stage === 'idle';
  elements.jogPanel.hidden = !showMachineJog;
  elements.pointPanel.hidden = showMachineJog;
  elements.jogLockReason.hidden = !reference;
  const setStep = (element,state,label) => {
    const previousState = element.dataset.state;
    if (previousState && previousState !== state) stepExpansionOverrides.delete(element.id);
    element.dataset.state = state;
    element.classList.remove('waiting','current','complete'); element.classList.add(state);
    element.querySelector('.stepState').textContent = label;
    const expanded = stepExpansionOverrides.has(element.id) ? stepExpansionOverrides.get(element.id) : state === 'current';
    element.classList.toggle('collapsed', !expanded);
    element.querySelector('.step-toggle').setAttribute('aria-expanded', String(expanded));
    element.querySelector('.step-chevron').textContent = expanded ? '⌃' : '⌄';
  };
  setStep(elements.centerStep, centerComplete ? 'complete' : 'current', centerComplete ? '✓ Complete' : 'Current');
  setStep(elements.referenceStep, referenceComplete ? 'complete' : centerComplete ? 'current' : 'waiting', referenceComplete ? '✓ Complete' : centerComplete ? 'Current' : 'Waiting');
  setStep(elements.toolsStep, toolsComplete ? 'complete' : referenceComplete ? 'current' : 'waiting', toolsComplete ? '✓ Complete' : referenceComplete ? 'Current' : 'Waiting');
  elements.cancelPoint.textContent = axisCaptureActive ? 'Abort axis calibration' : 'Select center again';
  elements.cancelPoint.disabled = !pendingPoint && !axisCaptureActive && lastConfirmedCorrection === null;
  document.querySelectorAll('.axis-calibration-button').forEach(button => {
    button.disabled = !reference || !!matrix || axisCaptureActive || busy;
    button.classList.toggle('primary', !!reference && !matrix && Number(button.dataset.distance) === axisDistance);
  });
  if (!reference) {
    elements.calData.textContent = 'T0 reference: not set';
    elements.referenceCrosshair.style.display = 'none';
  } else {
    elements.calData.textContent = matrix
      ? `T0 reference: ${reference.x.toFixed(1)}, ${reference.y.toFixed(1)} px\n+1 mm X: ${matrix.ax.x.toFixed(1)}, ${matrix.ax.y.toFixed(1)} px\n+1 mm Y: ${matrix.ay.x.toFixed(1)}, ${matrix.ay.y.toFixed(1)} px`
      : `T0 reference: ${reference.x.toFixed(1)}, ${reference.y.toFixed(1)} px\nImage axes: not calibrated`;
    place(elements.referenceCrosshair, reference);
    elements.referenceCrosshair.style.display = 'block';
  }
  if (pendingPoint) place(elements.marker, pendingPoint);
  elements.prepareT0.disabled = busy;
  elements.confirmCenter.disabled = !t0Prepared || centerComplete || busy;
  elements.prepareT0.classList.toggle('primary', !centerComplete && !t0Prepared);
  elements.confirmCenter.classList.toggle('primary', !centerComplete && t0Prepared);
  document.querySelectorAll('.t0-jog').forEach(button => { button.disabled = !showMachineJog || busy; });
  document.querySelectorAll('#toolButtons button').forEach(button => {
    const tool = Number(button.dataset.tool);
    if (completedTools.has(tool)) {
      const check = document.createElement('span'); check.className = 'tool-check'; check.textContent = '✓';
      button.replaceChildren(check, document.createTextNode(` T${tool}`));
    } else {
      button.textContent = `T${tool}`;
    }
    button.disabled = !matrix || busy;
    button.classList.toggle('primary', !!matrix && tool === calibrationTool);
  });
  document.querySelectorAll('.marker-nudge').forEach(button => { button.disabled = !pendingPoint; });
  elements.save.disabled = !matrix || calibrationTool === null || unsavedTool !== calibrationTool || busy;
  elements.save.hidden = calibrationTool === null;
  elements.save.classList.toggle('primary', unsavedTool !== null && unsavedTool === calibrationTool);
  elements.clearCalibration.disabled = busy;
  elements.undoStep.disabled = busy || (!pendingPoint && stage === 'idle' && !lastConfirmedCorrection && !matrix && !reference);
}

function renderOffsets(state) {
  const count = state?.toolCount || renderedToolCount || 0;
  const variables = state?.variables || {};
  elements.offsetRows.replaceChildren();
  if (!count) {
    const row = document.createElement('tr');
    const cell = document.createElement('td'); cell.colSpan = 4; cell.textContent = 'Waiting for printer…';
    row.append(cell); elements.offsetRows.append(row); return;
  }
  for (let tool=0; tool<count; tool++) {
    const x = tool === 0 ? 0 : Number(variables[`t${tool}_offset_x`]);
    const y = tool === 0 ? 0 : Number(variables[`t${tool}_offset_y`]);
    const saved = Number.isFinite(x) && Number.isFinite(y);
    const row = document.createElement('tr');
    for (const value of [`T${tool}`, saved ? x.toFixed(3) : '—', saved ? y.toFixed(3) : '—']) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    const status = document.createElement('td');
    const dirty = unsavedTool === tool;
    status.textContent = dirty ? 'unsaved' : saved ? 'saved' : 'not calibrated';
    status.className = dirty ? 'unsaved' : saved ? 'saved' : '';
    row.append(status); elements.offsetRows.append(row);
  }
}

document.querySelectorAll('.step-toggle').forEach(button => {
  button.onclick = () => {
    const step = button.closest('.workflow-step');
    const expanded = step.classList.contains('collapsed');
    stepExpansionOverrides.set(step.id, expanded);
    step.classList.toggle('collapsed', !expanded);
    button.setAttribute('aria-expanded', String(expanded));
    step.querySelector('.step-chevron').textContent = expanded ? '⌃' : '⌄';
  };
});

elements.prepareT0.onclick = async () => {
  try {
    if (!confirmDiscardUnsavedTool('T0')) return;
    clearPendingPoint(); stage = 'idle'; lastConfirmedCorrection = null;
    say('Picking T0 and moving to the saved camera position…');
    const prepared = await locked(() => adapter.prepareTool(0)) || {hasCameraReference:true};
    if (!prepared.hasCameraReference) {
      [referenceKey, matrixKey, completedToolsKey].forEach(key => localStorage.removeItem(key));
      reference = null; matrix = null; completedTools = new Set(); centerConfirmed = false;
    }
    latestState = await adapter.getStatus(); calibrationTool = null; t0Prepared = true;
    loadCurrentPositionIntoInputs(); renderCalibration();
    say(!prepared.hasCameraReference
      ? 'T0 is picked up and Z is homed. No camera-position move was made. Enter the camera XYZ coordinates, then move into view.'
      : reference
      ? 'T0 is at the saved camera position. Check it against the red crosshair; calibration data is unchanged.'
      : 'T0 is at the camera. Use the machine-coordinate jog controls to place it near the image center.', 'ok');
  } catch (error) { stage = 'idle'; say(error.message,'error'); }
};

elements.cameraSelect.onchange = () => {
  selectedCameraName = elements.cameraSelect.value;
  applySelectedCamera(); persistAppState();
  say(`Camera changed to ${selectedCameraName || 'default webcam'}. If its resolution differs, calibration will be cleared automatically.`,'ok');
};

elements.emergencyStop.onclick = async () => {
  if (!window.confirm('EMERGENCY STOP immediately shuts down Klipper and disables motion/heaters. Continue?')) return;
  elements.emergencyStop.disabled = true;
  try { await adapter.emergencyStop(); }
  catch (error) { say(`Emergency stop request: ${error.message}`,'error'); }
  finally { elements.emergencyStop.disabled = false; }
};

elements.undoStep.onclick = async () => {
  if (busy) return;
  if (pendingPoint || stage === 'captureX' || stage === 'captureY' || lastConfirmedCorrection) {
    elements.cancelPoint.click(); return;
  }
  if (matrix) {
    matrix = null; completedTools = new Set(); calibrationTool = null; unsavedTool = null;
    localStorage.removeItem(matrixKey); localStorage.removeItem(completedToolsKey);
    persistAppState(); renderCalibration(); renderOffsets(latestState);
    say('Image-axis calibration was undone. The T0 reference was kept.','ok'); return;
  }
  if (reference) {
    reference = null; centerConfirmed = false; t0Prepared = true; stage = 'idle';
    localStorage.removeItem(referenceKey); persistAppState(); renderCalibration();
    say('T0 reference was undone. Select its center again.','ok');
  }
};

elements.confirmCenter.onclick = () => {
  if (!t0Prepared || reference) return;
  centerConfirmed = true; clearPendingPoint(); calibrationTool = null; stage = 'setRef'; renderCalibration();
  say('T0 camera position confirmed. Click the nozzle-orifice center in the camera image.','ok');
};

document.querySelectorAll('.t0-jog').forEach(button => {
  button.onclick = async () => {
    if (!t0Prepared || reference) return;
    const x = Number(button.dataset.dx), y = Number(button.dataset.dy);
    try {
      clearPendingPoint(); stage = 'idle';
      say(`Jogging T0 by X${x>=0?'+':''}${x.toFixed(1)} / Y${y>=0?'+':''}${y.toFixed(1)} mm…`);
      await locked(() => adapter.moveRelative(x, y));
      renderCalibration();
      say('Check the image. Continue jogging until T0 is near the center, then select the T0 reference point.','ok');
    } catch (error) { renderCalibration(); say(error.message,'error'); }
  };
});

function loadCurrentPositionIntoInputs() {
  if (!latestState) return;
  [elements.targetX.value,elements.targetY.value,elements.targetZ.value] = latestState.position.map(value => Number(value).toFixed(3));
}

elements.loadCurrentPosition.onclick = loadCurrentPositionIntoInputs;
elements.moveToPosition.onclick = async () => {
  if (!t0Prepared || reference) return;
  if (!latestState || !String(latestState.homedAxes).includes('xyz')) {
    say('XYZ must be homed before moving to an entered position.','error'); return;
  }
  const target = [elements.targetX,elements.targetY,elements.targetZ].map(input => Number(input.value));
  if (!target.every(Number.isFinite)) { say('Enter valid X, Y and Z coordinates.','error'); return; }
  const current = latestState.position.map(Number);
  const safeZ = Math.max(current[2],target[2]);
  const lowZWarning = target[2] <= 25
    ? '\n\nWARNING: The entered Z position is 25 mm or lower and may collide with the camera.\nDo you still want to move?'
    : '';
  if (!window.confirm(
    `Move from X${current[0].toFixed(3)} Y${current[1].toFixed(3)} Z${current[2].toFixed(3)}\n`+
    `to X${target[0].toFixed(3)} Y${target[1].toFixed(3)} Z${target[2].toFixed(3)}?\n\n`+
    `Sequence: Z to ${safeZ.toFixed(3)}, then XY, then Z to ${target[2].toFixed(3)}.\n`+
    'Check the entire travel path and camera clearance before continuing.'+
    lowZWarning
  )) {
    say('XYZ move cancelled.'); return;
  }
  try {
    say(`Moving to X${target[0].toFixed(3)} Y${target[1].toFixed(3)} Z${target[2].toFixed(3)}…`);
    await locked(() => adapter.moveToPosition(target[0],target[1],target[2],latestState.position[2]));
    latestState = await adapter.getStatus(); loadCurrentPositionIntoInputs(); renderCalibration();
    say('Position reached. Check the image, then select the T0 reference point.','ok');
  } catch (error) { renderCalibration(); say(error.message,'error'); }
};

elements.cancelPoint.onclick = async () => {
  if (lastConfirmedCorrection && unsavedTool === calibrationTool) {
    const correction = lastConfirmedCorrection;
    try {
      clearPendingPoint();
      say(`Undoing the confirmed correction for T${calibrationTool}…`);
      await locked(() => adapter.moveRelative(-correction.x, -correction.y));
      unsavedTool = null; lastConfirmedCorrection = null;
      elements.toolGuide.textContent = `T${calibrationTool}: click the orifice center again, then confirm.`;
      renderCalibration(); renderOffsets(latestState);
      say(`T${calibrationTool} returned to its pre-confirm position. Click the orifice center again.`,'ok');
    } catch (error) { renderCalibration(); say(error.message,'error'); }
    return;
  }
  if (stage !== 'captureX' && stage !== 'captureY') {
    clearPendingPoint(); say('Selection cancelled. Click the orifice center again.'); return;
  }
  const abortStage = stage;
  try {
    clearPendingPoint();
    say('Aborting image-axis calibration and returning T0 to the reference position…');
    await locked(() => adapter.moveRelative(abortStage === 'captureX' ? -axisDistance : 0, abortStage === 'captureY' ? -axisDistance : 0));
    stage = 'idle'; xPoint = null; renderCalibration();
    say('Image-axis calibration aborted. T0 has returned to the reference position. Select 0.5 mm if the nozzle left the camera view, then retry.','ok');
  } catch (error) { renderCalibration(); say(error.message,'error'); }
};

elements.clearCalibration.onclick = () => {
  [referenceKey, matrixKey, completedToolsKey].forEach(key => localStorage.removeItem(key));
  reference = null; matrix = null; xPoint = null; stage = 'idle'; calibrationTool = null; unsavedTool = null;
  lastConfirmedCorrection = null;
  completedTools = new Set();
  centerConfirmed = false; t0Prepared = false;
  persistAppState();
  clearPendingPoint(); renderCalibration();
  elements.toolGuide.textContent = 'T0 is the reference and is not saved. Calibrate the image axes, then start with T1.';
  say('Camera calibration data cleared. Start again from the T0 reference.','ok');
};

document.querySelectorAll('.axis-calibration-button').forEach(button => { button.onclick = async () => {
  if (!reference || stage === 'captureX' || stage === 'captureY' || busy) return;
  axisDistance = Number(button.dataset.distance);
  try {
    clearPendingPoint();
    say(`Moving X by +${axisDistance.toFixed(1)} mm. When motion stops, click the nozzle-orifice center. If it leaves the image, press “Abort axis calibration” and retry with a smaller distance.`);
    await locked(() => adapter.moveRelative(axisDistance, 0));
    stage = 'captureX';
    renderCalibration();
  } catch (error) { say(error.message,'error'); }
}; });

elements.viewer.onclick = event => {
  if (busy) return;
  if (stage === 'idle' && calibrationTool === null) {
    say(matrix ? `Select a tool from ${toolRangeLabel} first. T0 is not an offset target.` : 'Set the T0 reference and calibrate the image axes first.','error');
    return;
  }
  const {width,height} = imageSize();
  pendingPoint = imagePointFromClient(event.clientX, event.clientY, elements.stream.getBoundingClientRect(), width, height);
  place(elements.marker, pendingPoint); elements.marker.style.display = 'block';
  elements.confirmPoint.disabled = false;
  elements.cancelPoint.disabled = false;
  document.querySelectorAll('.marker-nudge').forEach(button => { button.disabled = false; });
  say('Check the green marker. Click again to correct it, or press “Confirm this point”.');
};

elements.confirmPoint.onclick = async () => {
  if (!pendingPoint || busy) return;
  const point = pendingPoint;
  try {
    if (stage === 'setRef') {
      const {width,height} = imageSize();
      if (!isPointInCentralRegion(point, width, height)) {
        throw new Error('T0 is too close to an image edge. Use Step 0 to place it within the central 40%, then click again.');
      }
      reference = {x:point.x, y:point.y, width, height}; matrix = null;
      localStorage.setItem(referenceKey, JSON.stringify(reference)); localStorage.removeItem(matrixKey);
      persistAppState();
      stage = 'idle'; clearPendingPoint(); renderCalibration();
      say('T0 image reference saved. Next, calibrate the image axes with the 1 mm moves.','ok');
      return;
    }
    if (stage === 'captureX') {
      xPoint = point;
      say(`X axis recorded. Returning X and moving Y by +${axisDistance.toFixed(1)} mm. Then click the orifice center.`);
      await locked(() => adapter.moveRelative(-axisDistance, axisDistance));
      clearPendingPoint(); stage = 'captureY'; renderCalibration(); return;
    }
    if (stage === 'captureY') {
      matrix = createCalibrationMatrix(reference, xPoint, point, axisDistance, axisDistance);
      localStorage.setItem(matrixKey, JSON.stringify(matrix));
      await locked(() => adapter.moveRelative(0, -axisDistance));
      await locked(() => adapter.saveCameraReference());
      persistAppState();
      clearPendingPoint(); stage = 'idle'; renderCalibration();
      say('Image-axis calibration complete; T0 has returned. Verify the orifice matches the red crosshair, then select T1.','ok');
      return;
    }
    if (!reference || !matrix) throw new Error('Set the T0 reference and calibrate the image axes first.');
    const move = movementToReference(reference, point, matrix);
    say(`Moving XY by X${move.x>=0?'+':''}${move.x.toFixed(3)} / Y${move.y>=0?'+':''}${move.y.toFixed(3)} mm.`);
    await locked(() => adapter.moveRelative(move.x, move.y));
    unsavedTool = calibrationTool;
    lastConfirmedCorrection = {x:move.x,y:move.y};
    completedTools.delete(calibrationTool);
    localStorage.setItem(completedToolsKey, JSON.stringify([...completedTools]));
    persistAppState();
    elements.save.textContent = `Save T${calibrationTool} XY`;
    elements.toolGuide.textContent = `T${calibrationTool}: correction confirmed but not saved. Save before continuing.`;
    renderCalibration(); renderOffsets(latestState);
    clearPendingPoint();
    say(`Correction applied. Save T${calibrationTool} XY before continuing.`,'ok');
  } catch (error) { say(error.message,'error'); }
};

document.querySelectorAll('.marker-nudge').forEach(button => {
  button.onclick = () => {
    if (!pendingPoint) return;
    const [pixelX,pixelY] = button.dataset.px.split(',').map(Number);
    const {width,height} = imageSize();
    pendingPoint = nudgePoint(pendingPoint, pixelX, pixelY, width, height);
    place(elements.marker, pendingPoint);
    say(`Green marker nudged 1 px ${pixelX<0?'left':pixelX>0?'right':pixelY<0?'up':'down'}.`);
  };
});

function renderToolButtons(toolCount) {
  if (toolCount === renderedToolCount) return;
  renderedToolCount = toolCount;
  toolRangeLabel = toolCount > 1 ? `T1–T${toolCount-1}` : 'no adjustable tools';
  if (calibrationTool === null) elements.save.textContent = `Save XY for ${toolRangeLabel}`;
  elements.toolButtons.replaceChildren();
  for (let tool=1; tool<toolCount; tool++) {
    const button = document.createElement('button'); button.textContent = `T${tool}`; button.dataset.tool = tool;
    button.onclick = async () => {
      try {
        if (!confirmDiscardUnsavedTool(`T${tool}`)) return;
        clearPendingPoint(); calibrationTool = null; t0Prepared = false; lastConfirmedCorrection = null; renderCalibration();
        say(`Picking T${tool} and moving to the camera reference…`);
        await locked(() => adapter.prepareTool(tool));
        calibrationTool = tool; elements.save.textContent = `Save T${tool} XY`;
        elements.toolGuide.textContent = `T${tool}: click and confirm the orifice center, verify alignment, then save.`;
        renderCalibration(); say(`Click the center of the T${tool} orifice, check the marker, then confirm.`,'ok');
      } catch (error) { calibrationTool = null; renderCalibration(); say(error.message,'error'); }
    };
    elements.toolButtons.append(button);
  }
  renderCalibration();
}

elements.save.onclick = async () => {
  if (calibrationTool === null) return;
  try {
    clearPendingPoint();
    const tool = calibrationTool;
    say(`Saving the T${tool} XY offset and verifying the stored values…`);
    const verified = await locked(() => adapter.saveAndVerifyToolOffset(tool));
    completedTools.add(tool);
    localStorage.setItem(completedToolsKey, JSON.stringify([...completedTools].sort((a,b) => a-b)));
    persistAppState();
    say(`✓ T${tool} XY save verified: X ${verified.saved.x.toFixed(3)} / Y ${verified.saved.y.toFixed(3)} mm (no nozzle motion)`,'ok');
    unsavedTool = null; calibrationTool = null; lastConfirmedCorrection = null; elements.save.textContent = `Save XY for ${toolRangeLabel}`;
    elements.toolGuide.textContent = 'The nozzle remains in place after saving. If it matches the crosshair, select the next tool.';
    latestState = await adapter.getStatus();
    renderCalibration(); renderOffsets(latestState);
  } catch (error) { say(error.message,'error'); }
};

async function refreshStatus() {
  try {
    const state = await adapter.getStatus();
    latestState = state;
    const coordinateInputs = [elements.targetX,elements.targetY,elements.targetZ];
    if (!elements.jogPanel.hidden && !coordinateInputs.includes(document.activeElement)) loadCurrentPositionIntoInputs();
    if (state.toolCount) renderToolButtons(state.toolCount);
    renderOffsets(state);
    elements.status.textContent = `${adapter.name} connected | T${state.activeTool ?? '?'} | ${state.homedAxes || 'unhomed'}`;
    elements.position.textContent = `X ${state.position[0].toFixed(3)}  Y ${state.position[1].toFixed(3)}  Z ${state.position[2].toFixed(3)}\nactive_tool ${state.activeTool}  tool_count ${state.toolCount ?? '?'}`;
  } catch (_error) { elements.status.textContent = `${adapter.name} disconnected`; }
}

elements.stream.addEventListener('load', () => {
  const {width,height} = imageSize();
  if (reference && (reference.width !== width || reference.height !== height)) {
    [referenceKey, matrixKey, completedToolsKey].forEach(key => localStorage.removeItem(key));
    reference = null; matrix = null; completedTools = new Set(); centerConfirmed = false; t0Prepared = false;
    persistAppState();
    say(`Camera resolution changed to ${width}×${height}. Camera calibration data was cleared; recalibrate T0.`,'error');
  }
  renderCalibration();
});
window.addEventListener('resize', () => { renderCalibration(); });
async function initialize() {
  await restoreAppState();
  await loadWebcams();
  renderCalibration(); renderCameraDisplay(); refreshStatus(); setInterval(refreshStatus, 2000);
}
initialize();
