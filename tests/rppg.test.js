import test from "node:test";
import assert from "node:assert/strict";
import { estimateBpm, pos, resample } from "../rppg.js";

function randomNormal(random) {
  const first = Math.max(random(), 1e-12);
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function makeTrace(targetBpm) {
  let seed = 0x12345678 + targetBpm;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const timestamps = [];
  const rgb = [];
  const base = [150, 110, 90];
  for (let frame = 0; frame < 300; frame += 1) {
    const time = frame / 30 + (random() * 16 - 8) / 1000;
    timestamps.push(time * 1000);
    const pulse = Math.sin((2 * Math.PI * targetBpm * time) / 60);
    const lighting = 1 + 0.0005 * time;
    rgb.push(
      base.map((channel, index) => {
        const ratio = [0.003, 0.006, 0.002][index];
        return channel * lighting * (1 + ratio * pulse) + channel * 0.0006 * randomNormal(random);
      }),
    );
  }
  return { timestamps, rgb };
}

test("resample interpolates an irregular trace onto a uniform grid", () => {
  const result = resample([0, 500, 1000], [[0, 1, 2], [1, 2, 3], [2, 3, 4]], 4);
  assert.equal(result.length, 5);
  assert.deepEqual(result[2], [1, 2, 3]);
  assert.deepEqual(result[4], [2, 3, 4]);
  assert.throws(() => resample([0, 0], [[1, 2, 3], [2, 3, 4]]), /strictly increasing/);
});

for (const targetBpm of [60, 72, 90, 120]) {
  test(`recovers ${targetBpm} BPM from jittered synthetic RGB`, () => {
    const trace = makeTrace(targetBpm);
    const uniform = resample(trace.timestamps, trace.rgb, 30);
    const result = estimateBpm(pos(uniform, 30), 30);
    console.log(
      `synthetic ${targetBpm}: ${result.bpm.toFixed(2)} BPM, SNR ${result.snr.toFixed(1)} dB`,
    );
    assert.ok(Math.abs(result.bpm - targetBpm) <= 2, `${result.bpm} BPM`);
  });
}
