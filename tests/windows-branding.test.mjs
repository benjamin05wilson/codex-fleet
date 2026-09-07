import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ico, bitmap } from "../scripts/windows-branding.mjs";

test("checked-in Windows icon contains Fleet PNGs at small and high-DPI sizes", () => {
  const data = readFileSync(
    new URL("../desktop/assets/fleet.ico", import.meta.url),
  );
  assert.equal(data.readUInt16LE(0), 0);
  assert.equal(data.readUInt16LE(2), 1);
  assert.equal(data.readUInt16LE(4), 5);
  const images = [];
  for (let i = 0; i < 5; i++) {
    const entry = 6 + i * 16,
      size = [16, 32, 64, 128, 256][i];
    assert.equal(data[entry] || 256, size);
    const offset = data.readUInt32LE(entry + 12),
      length = data.readUInt32LE(entry + 8);
    const png = data.subarray(offset, offset + length);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    images.push(png);
  }
  assert.deepEqual(ico(images), data);
});

test("installer artwork is a correctly sized, uncompressed Windows bitmap", () => {
  for (const [name, width, height] of [
    ["sidebar", 164, 314],
    ["header", 150, 57],
  ]) {
    const data = readFileSync(
      new URL(`../desktop/assets/installer-${name}.bmp`, import.meta.url),
    );
    assert.equal(data.subarray(0, 2).toString(), "BM");
    assert.equal(data.readUInt32LE(2), data.length);
    assert.equal(data.readInt32LE(18), width);
    assert.equal(data.readInt32LE(22), height);
    assert.equal(data.readUInt16LE(28), 24);
    assert.equal(data.readUInt32LE(30), 0);
    assert(
      data.includes(Buffer.from([120, 173, 227])),
      "Fleet amber mark missing",
    );
  }
  const sample = bitmap(1, 2, (_x, y) => (y < 1 ? [255, 0, 0] : [0, 255, 0]));
  assert.deepEqual([...sample.subarray(54)], [0, 255, 0, 0, 0, 0, 255, 0]);
});
