export class IndxAdapter {
  constructor(fetchFunction = globalThis.fetch.bind(globalThis), baseUrl = '', sleepFunction = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    this.fetch = fetchFunction;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.sleep = sleepFunction;
    this.name = 'INDX';
  }

  async gcode(script) {
    const response = await this.fetch(`${this.baseUrl}/printer/gcode/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script })
    });
    let payload;
    try {
      if (typeof response.text === 'function') {
        const text = await response.text();
        payload = JSON.parse(text);
      } else {
        payload = await response.json();
      }
    } catch (_error) {
      const error = new Error(response.status >= 500
        ? `The web proxy stopped waiting for the printer (HTTP ${response.status}). The command may still be running.`
        : `Moonraker returned a non-JSON response (HTTP ${response.status}).`);
      error.indeterminate = response.status >= 500;
      throw error;
    }
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message || `HTTP ${response.status}`);
    }
    return payload;
  }

  async runTrackedGcode(script) {
    const token = `${Date.now()}-${Math.floor(Math.random()*1e6)}`;
    const trackedScript = `${script}\nSAVE_VARIABLE VARIABLE=nozzlecam_operation_token VALUE='"${token}"'`;
    try {
      await this.gcode(trackedScript);
      return {recoveredAfterProxyTimeout:false};
    } catch (error) {
      if (!error.indeterminate) throw error;
    }
    for (let attempt=0; attempt<240; attempt++) {
      await this.sleep(1000);
      try {
        const variables = (await this.getStatus()).variables || {};
        if (String(variables.nozzlecam_operation_token ?? '') === token) {
          return {recoveredAfterProxyTimeout:true};
        }
      } catch (_error) {
        // Moonraker can be briefly unavailable while the original command is still running.
      }
    }
    throw new Error('The printer did not confirm completion within four minutes. Check printer status before retrying.');
  }

  async getStatus() {
    const response = await this.fetch(`${this.baseUrl}/printer/objects/query?toolhead&save_variables&gcode_macro%20TOOL_POSITIONS`);
    const payload = await response.json();
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message || `HTTP ${response.status}`);
    }
    const status = payload.result.status;
    const toolCount = Number(status['gcode_macro TOOL_POSITIONS']?.tool_count);
    return {
      position: status.toolhead.position,
      homedAxes: status.toolhead.homed_axes || '',
      activeTool: status.save_variables.variables.active_tool,
      toolCount: Number.isInteger(toolCount) && toolCount > 0 ? toolCount : null,
      variables: status.save_variables.variables
    };
  }

  async listWebcams() {
    const response = await this.fetch(`${this.baseUrl}/server/webcams/list`);
    const payload = await response.json();
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message || `HTTP ${response.status}`);
    }
    return (payload.result?.webcams || []).map(webcam => ({
      name: String(webcam.name || 'Webcam'),
      streamUrl: String(webcam.stream_url || ''),
      snapshotUrl: String(webcam.snapshot_url || '')
    })).filter(webcam => webcam.streamUrl);
  }

  async emergencyStop() {
    const response = await this.fetch(`${this.baseUrl}/printer/emergency_stop`, {method:'POST'});
    let payload = {};
    try { payload = await response.json(); } catch (_error) { /* shutdown can close the response */ }
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message || `HTTP ${response.status}`);
    }
    return payload;
  }

  async loadAppState() {
    const response = await this.fetch(`${this.baseUrl}/server/database/item?namespace=indx_aim_and_click&key=calibration`);
    const payload = await response.json();
    if (response.status === 404 || payload.error) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return payload.result?.value ?? null;
  }

  async saveAppState(value) {
    const response = await this.fetch(`${this.baseUrl}/server/database/item`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({namespace:'indx_aim_and_click',key:'calibration',value})
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error?.message || `HTTP ${response.status}`);
    return payload.result;
  }

  async prepareTool(tool) {
    const status = await this.getStatus();
    const variables = status.variables || {};
    const hasCameraReference = ['cam_pos_x','cam_pos_y','cam_pos_z']
      .every(key => Number.isFinite(Number(variables[key])));
    if (!hasCameraReference && tool !== 0) {
      throw new Error('Camera position is not saved. Prepare and position T0 first.');
    }
    const needsZHome = !String(status.homedAxes).includes('z');
    const script = hasCameraReference
      ? `CAL_TWO_PREP_TOOL_CAL TOOL=${tool}`
      : [
          'CHANGE_TOOL TOOL=0 SKIP_Z_CORRECTION=1',
          '_CAL_LATCH_ENGAGE',
          ...(needsZHome ? ['G28 Z'] : []),
          'SET_GCODE_OFFSET X=0 Y=0 Z=0'
        ].join('\n');
    const result = await this.runTrackedGcode(script);
    return {...result,hasCameraReference,movedToCamera:hasCameraReference,zHomed:needsZHome};
  }
  saveCameraReference() { return this.gcode('CAL_ONE_SET_CAMERA_REF'); }
  saveToolOffset() { return this.gcode('CAL_THREE_SAVE_XY_OFFSET'); }
  async saveAndVerifyToolOffset(tool) {
    const before = await this.getStatus();
    const variables = before.variables || {};
    const expected = tool === 0 ? {x:0,y:0} : {
      x: Number((before.position[0] - Number(variables.cam_pos_x)).toFixed(3)),
      y: Number((before.position[1] - Number(variables.cam_pos_y)).toFixed(3))
    };
    if (!Number.isFinite(expected.x) || !Number.isFinite(expected.y)) throw new Error('Unable to read the saved camera reference coordinates.');
    await this.saveToolOffset();
    for (let attempt=0; attempt<10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const savedVariables = (await this.getStatus()).variables || {};
      const saved = {x:Number(savedVariables[`t${tool}_offset_x`]), y:Number(savedVariables[`t${tool}_offset_y`])};
      if (Math.abs(saved.x-expected.x) < 0.0005 && Math.abs(saved.y-expected.y) < 0.0005) return {expected,saved};
    }
    const latest = (await this.getStatus()).variables || {};
    throw new Error(`Could not verify T${tool} saved values (expected X${expected.x.toFixed(3)} Y${expected.y.toFixed(3)} / read X${latest[`t${tool}_offset_x`] ?? '?'} Y${latest[`t${tool}_offset_y`] ?? '?'}).`);
  }
  moveRelative(x, y) {
    const parts = [];
    if (x !== 0) parts.push(`X${x.toFixed(4)}`);
    if (y !== 0) parts.push(`Y${y.toFixed(4)}`);
    return this.gcode(`G91\nG0 ${parts.join(' ')} F600\nG90\nM400`);
  }
  moveToPosition(x, y, z, currentZ) {
    const safeZ = Math.max(z, currentZ);
    return this.gcode(`G90\nG0 Z${safeZ.toFixed(4)} F1500\nG0 X${x.toFixed(4)} Y${y.toFixed(4)} F600\nG0 Z${z.toFixed(4)} F600`);
  }
}
