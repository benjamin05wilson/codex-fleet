import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

// Reuse the exact PNGs produced by icon.swift for the Mac icon. Checked-in
// Windows assets let Windows CI package without Swift or a graphics dependency.
export function ico(images) {
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach((png, index) => {
    const size = png.readUInt32BE(16);
    if (size > 256 || size !== png.readUInt32BE(20))
      throw new Error("Windows icons must be square PNGs up to 256px.");
    const entry = 6 + index * 16;
    directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([directory, ...images]);
}

const dark = [23, 24, 28],
  amber = [227, 173, 120];
function inside(x, y, left, top, width, height, radius) {
  const dx = Math.max(left + radius - x, 0, x - (left + width - radius));
  const dy = Math.max(top + radius - y, 0, y - (top + height - radius));
  return dx * dx + dy * dy <= radius * radius;
}
function mark(x, y, left, top, size, background) {
  x = ((x - left) * 1024) / size;
  y = ((y - top) * 1024) / size;
  // Same geometry and colour as icon.swift, with the vertical axis flipped.
  for (const [barY, width] of [
    [286, 490],
    [468, 345],
    [650, 190],
  ])
    if (inside(x, y, 272, barY, width, 88, 5)) return amber;
  return inside(x, y, 70, 70, 884, 884, 195) ? dark : background;
}
export function bitmap(width, height, pixel) {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(54 + stride * height);
  data.write("BM");
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(width, 18);
  data.writeInt32LE(height, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(24, 28);
  data.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const colour = [0, 0, 0];
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const sample = pixel(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4);
          sample.forEach((value, i) => (colour[i] += value / 16));
        }
      const pos = 54 + (height - 1 - y) * stride + x * 3;
      data[pos] = Math.round(colour[2]);
      data[pos + 1] = Math.round(colour[1]);
      data[pos + 2] = Math.round(colour[0]);
    }
  }
  return data;
}
export async function generateWindowsBranding() {
  const source = resolve("build/fleet.iconset"),
    output = resolve("desktop/assets");
  const files = [
    "icon_16x16.png",
    "icon_32x32.png",
    "icon_32x32@2x.png",
    "icon_128x128.png",
    "icon_256x256.png",
  ];
  const images = await Promise.all(
    files.map((file) => readFile(join(source, file))),
  );
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "fleet.ico"), ico(images));
  await writeFile(
    join(output, "installer-sidebar.bmp"),
    bitmap(164, 314, (x, y) => mark(x, y, 12, 28, 140, dark)),
  );
  await writeFile(
    join(output, "installer-header.bmp"),
    bitmap(150, 57, (x, y) => mark(x, y, 99, 4, 49, [255, 255, 255])),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await generateWindowsBranding();
