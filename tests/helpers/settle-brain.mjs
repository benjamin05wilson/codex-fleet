// A writer can enqueue a newer index generation while notes are being read.
// Seeing its text alone does not mean that generation has completed indexing.
export async function settleBrain(brain, project, matches, maxBatches = 8) {
  const observations = [];
  let written;
  for (let batch = 0; batch < maxBatches; batch++) {
    await brain.writer.drain();
    await brain.drain();
    const notes = await brain.list(project, { scope: "project" });
    written = notes.find(matches);
    const job = brain.status(project);
    observations.push({
      batch: batch + 1,
      matched: Boolean(written),
      status: job.status,
      generation: job.generation,
      attempts: job.attempts,
      retryAt: job.retryAt,
      error: job.error,
    });
    if (written && job.status === "complete") return { written, observations };
  }
  throw new Error(`Brain did not settle: ${JSON.stringify(observations)}`);
}
