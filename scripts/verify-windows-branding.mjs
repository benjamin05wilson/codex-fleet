import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { NtExecutable, NtExecutableResource, Resource, Data } = createRequire(
  require.resolve("app-builder-lib/package.json"),
)("resedit");

export function verifyWindowsBranding(file) {
  const expected = Data.IconFile.from(
    readFileSync(new URL("../desktop/assets/fleet.ico", import.meta.url)),
  ).icons.map((item) => Buffer.from(item.data.bin));
  const executable = NtExecutable.from(readFileSync(file), {
    ignoreCert: true,
  });
  const { entries } = NtExecutableResource.from(executable);
  const groups = Resource.IconGroupEntry.fromEntries(entries);
  assert(
    groups.some((group) => {
      const images = group.getIconItemsFromEntries(entries);
      return (
        images.length === expected.length &&
        expected.every((png) =>
          images.some(
            (image) => image.isRaw() && Buffer.from(image.bin).equals(png),
          ),
        )
      );
    }),
    `Fleet's complete icon set is missing from ${file}`,
  );
  console.log(`Verified embedded Fleet branding: ${file}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  assert(
    process.argv[2],
    "Pass the Windows executable or installer to verify.",
  );
  for (const file of process.argv.slice(2)) verifyWindowsBranding(file);
}
