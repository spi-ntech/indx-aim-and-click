import test from 'node:test';
import assert from 'node:assert/strict';
import { IndxAdapter } from '../js/indx-adapter.js';

function response(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

test('queries INDX state and exposes normalized status', async () => {
  const calls = [];
  const adapter = new IndxAdapter(async (url, options) => {
    calls.push({url, options});
    return response({result:{status:{
      toolhead:{position:[1,2,3],homed_axes:'xyz'},
      save_variables:{variables:{active_tool:4}},
      'gcode_macro TOOL_POSITIONS':{tool_count:9}
    }}});
  });
  assert.deepEqual(await adapter.getStatus(), {
    position:[1,2,3], homedAxes:'xyz', activeTool:4, toolCount:9,
    variables:{active_tool:4}
  });
  assert.match(calls[0].url, /TOOL_POSITIONS/);
});

test('verifies saved XY values after the macro finishes', async () => {
  const adapter = new IndxAdapter();
  let reads = 0;
  adapter.getStatus = async () => {
    reads++;
    return {
      position:[11.211,68.608,28], variables:{
        cam_pos_x:11.088, cam_pos_y:69.064,
        ...(reads > 1 ? {t5_offset_x:0.123,t5_offset_y:-0.456} : {})
      }
    };
  };
  adapter.saveToolOffset = async () => {};
  const result = await adapter.saveAndVerifyToolOffset(5);
  assert.deepEqual(result, {expected:{x:0.123,y:-0.456},saved:{x:0.123,y:-0.456}});
});

test('emits the existing INDX calibration commands without MOVE=1', async () => {
  const scripts = [];
  const adapter = new IndxAdapter(async (_url, options) => {
    if (!options) return response({result:{status:{
      toolhead:{position:[1,2,3],homed_axes:'xyz'},
      save_variables:{variables:{active_tool:0,cam_pos_x:15,cam_pos_y:71,cam_pos_z:28}},
      'gcode_macro TOOL_POSITIONS':{tool_count:7}
    }}});
    scripts.push(JSON.parse(options.body).script);
    return response({result:'ok'});
  });
  await adapter.prepareTool(5);
  await adapter.moveRelative(0.125, -0.25);
  await adapter.moveToPosition(11.2, 68.9, 27.5, 28);
  await adapter.saveToolOffset();
  assert.match(scripts[0], /^CAL_TWO_PREP_TOOL_CAL TOOL=5\nSAVE_VARIABLE VARIABLE=nozzlecam_operation_token/);
  assert.match(scripts[1], /X0\.1250 Y-0\.2500/);
  assert.equal(scripts[2], 'G90\nG0 Z28.0000 F1500\nG0 X11.2000 Y68.9000 F600\nG0 Z27.5000 F600');
  assert.equal(scripts[3], 'CAL_THREE_SAVE_XY_OFFSET');
  assert.ok(!scripts.join('\n').includes('MOVE=1'));
});

test('picks T0 without moving to coordinates when no camera reference exists', async () => {
  const scripts = [];
  const adapter = new IndxAdapter(async (_url, options) => {
    if (!options) return response({result:{status:{
      toolhead:{position:[120,120,30],homed_axes:'xyz'},
      save_variables:{variables:{active_tool:-1}},
      'gcode_macro TOOL_POSITIONS':{tool_count:7}
    }}});
    scripts.push(JSON.parse(options.body).script);
    return response({result:'ok'});
  });
  const result = await adapter.prepareTool(0);
  assert.equal(result.hasCameraReference,false);
  assert.match(scripts[0], /^CHANGE_TOOL TOOL=0 SKIP_Z_CORRECTION=1/);
  assert.doesNotMatch(scripts[0], /G28 Z/);
  assert.match(scripts[0], /SET_GCODE_OFFSET X=0 Y=0 Z=0/);
  assert.ok(!scripts[0].includes('G0 '));
  assert.ok(!scripts[0].includes('MOVE=1'));
});

test('homes Z after picking T0 when camera reference and Z home are both missing', async () => {
  const scripts = [];
  const adapter = new IndxAdapter(async (url, options) => {
    if (url.includes('/objects/query')) return response({result:{status:{
      toolhead:{position:[120,120,30],homed_axes:'xy'},
      save_variables:{variables:{}},
      'gcode_macro TOOL_POSITIONS':{tool_count:7}
    }}});
    scripts.push(JSON.parse(options.body).script);
    return response({result:'ok'});
  });
  const result = await adapter.prepareTool(0);
  assert.match(scripts[0], /_CAL_LATCH_ENGAGE\nG28 Z\nSET_GCODE_OFFSET/);
  assert.equal(result.zHomed, true);
});

test('waits for tracked completion after a proxy timeout without resending', async () => {
  let submitted = 0;
  let token = '';
  const adapter = new IndxAdapter(undefined,'',async () => {});
  adapter.gcode = async script => {
    submitted++;
    token = script.match(/VALUE='"([^"]+)"'/)[1];
    const error = new Error('HTTP 504'); error.indeterminate = true; throw error;
  };
  adapter.getStatus = async () => ({variables:{nozzlecam_operation_token:token}});
  const result = await adapter.runTrackedGcode('CAL_TWO_PREP_TOOL_CAL TOOL=0');
  assert.equal(submitted,1);
  assert.equal(result.recoveredAfterProxyTimeout,true);
});

test('lists Moonraker webcams and normalizes stream URLs', async () => {
  const adapter = new IndxAdapter(async url => {
    assert.equal(url, '/server/webcams/list');
    return {ok:true,json:async()=>({result:{webcams:[
      {name:'Nozzle',stream_url:'/webcam2/?action=stream',snapshot_url:'/webcam2/?action=snapshot'},
      {name:'Disabled',stream_url:''}
    ]}})};
  });
  assert.deepEqual(await adapter.listWebcams(), [{
    name:'Nozzle',streamUrl:'/webcam2/?action=stream',snapshotUrl:'/webcam2/?action=snapshot'
  }]);
});

test('uses Moonraker emergency stop endpoint', async () => {
  const calls = [];
  const adapter = new IndxAdapter(async (url, options) => {
    calls.push({url,options});
    return {ok:true,json:async()=>({result:'ok'})};
  });
  await adapter.emergencyStop();
  assert.equal(calls[0].url, '/printer/emergency_stop');
  assert.equal(calls[0].options.method, 'POST');
});

test('stores persistent calibration state in a dedicated Moonraker namespace', async () => {
  const calls = [];
  const adapter = new IndxAdapter(async (url, options) => {
    calls.push({url,options});
    return {ok:true,status:200,json:async()=> options
      ? {result:{value:JSON.parse(options.body).value}}
      : {result:{value:{selectedCamera:'Nozzle'}}}};
  });
  assert.deepEqual(await adapter.loadAppState(), {selectedCamera:'Nozzle'});
  await adapter.saveAppState({selectedCamera:'Nozzle'});
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.namespace, 'indx_aim_and_click');
  assert.equal(body.key, 'calibration');
});
