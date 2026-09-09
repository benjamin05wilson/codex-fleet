let prompt = "";
let result = {
  markdown: "A fixture result from `src/api.js`.",
  sources: ["src/api.js"],
};
const schemaArg = process.argv.indexOf("--output-schema");
if (schemaArg >= 0) {
  const { readFile } = await import("node:fs/promises");
  const schema = JSON.parse(
    await readFile(process.argv[schemaArg + 1], "utf8"),
  );
  if (schema.additionalProperties !== false) process.exit(3);
  if (schema.properties.edits) {
    const properties = schema.properties.edits.items.properties;
    result = {
      edits: [
        {
          sectionId: properties.sectionId.enum[0],
          markdown: "A fixture wiki section.",
          sources: [properties.sources.items.enum[0]],
        },
      ],
    };
  } else if (schema.properties.sources.items.enum[0] !== "src/api.js")
    process.exit(3);
}
for await (const chunk of process.stdin) prompt += chunk;
if (prompt === "hang") {
  console.log(
    JSON.stringify({
      type: "item.completed",
      item: { type: "reasoning", text: "Waiting for cancellation." },
    }),
  );
  setInterval(() => {}, 1000);
} else {
  console.log(
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: JSON.stringify(result),
      },
    }),
  );
  console.log(
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 5, output_tokens: 5 },
    }),
  );
}
