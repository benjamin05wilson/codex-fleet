import { fleetFetch } from "./helpers/http.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAuth } from "../server/auth.mjs";
import { createApp } from "../server/app.mjs";
import { validAuthURL, isAuthenticationError } from "../shared/auth.mjs";
import { verifyDownload } from "../scripts/prepare-tools.mjs";

class Client extends EventEmitter {
  authenticated = false;
  calls = [];
  async connect() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "account/read")
      return {
        account: this.authenticated
          ? { type: "chatgpt", secret: "never-expose" }
          : null,
        requiresOpenaiAuth: true,
      };
    if (method === "account/login/start")
      return {
        loginId: "one",
        authUrl: "https://auth.openai.com/authorize?state=private-login",
      };
    if (method === "windowsSandbox/setupStart") return { started: true };
    return {};
  }
  close() {
    this.emit("closed");
  }
}
test("the subprocess Codex fixture supplies authentication without a machine login", async (t) => {
  const auth = new CodexAuth(
    fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)),
    tmpdir(),
  );
  t.after(() => auth.close());
  const state = await auth.read(true);
  assert.equal(state.available, true);
  assert.equal(state.authenticated, true);
  assert(!JSON.stringify(state).includes("must-not-be-exposed"));
});
test("sign-in is single-flight, exposes no account secrets and waits for confirmed login", async (t) => {
  const client = new Client();
  const auth = new CodexAuth("", "", { clientFactory: () => client });
  t.after(() => auth.close());
  await assert.rejects(auth.requireReady(), {
    code: "CODEX_SIGN_IN_REQUIRED",
    status: 428,
  });
  const results = await Promise.all([auth.start(), auth.start()]);
  assert.equal(results[0].authUrl, results[1].authUrl);
  assert.equal(
    client.calls.filter((c) => c.method === "account/login/start").length,
    1,
  );
  assert.equal(auth.publicState().waiting, true);
  assert(!JSON.stringify(auth.publicState()).includes("private-login"));
  client.authenticated = true;
  client.emit("notification", {
    method: "account/login/completed",
    params: { loginId: "one", success: true },
  });
  await auth.requireReady();
  assert.equal(auth.publicState().authenticated, true);
  assert(!JSON.stringify(auth.publicState()).includes("never-expose"));
  auth.invalidate();
  await assert.rejects(auth.requireReady(), { status: 428 });
  await auth.start();
  client.emit("notification", {
    method: "account/login/completed",
    params: { loginId: "one", success: true },
  });
  await auth.requireReady();
});
test("cancelled sign-in never authorizes a task; invalid URLs fail closed", async (t) => {
  const client = new Client();
  const auth = new CodexAuth("", "", { clientFactory: () => client });
  t.after(() => auth.close());
  await auth.start();
  await auth.cancel();
  assert.equal(auth.publicState().waiting, false);
  await assert.rejects(auth.requireReady());
  assert(client.calls.some((c) => c.method === "account/login/cancel"));
  for (const url of [
    "http://auth.openai.com/x",
    "https://auth.openai.com.evil.test/x",
    "file:///etc/passwd",
    "https://user@auth.openai.com/x",
    "https://auth.openai.com:8443/x",
    "javascript:alert(1)",
  ])
    assert.equal(validAuthURL(url), false);
  assert.equal(validAuthURL("https://auth.openai.com/authorize?state=x"), true);
  assert(isAuthenticationError("unexpected status 401 Unauthorized"));
  assert(!isAuthenticationError("timeout connecting to server"));
  assert.throws(
    () => verifyDownload(Buffer.from("bad"), "sha256", "0".repeat(64)),
    /checksum/,
  );
});
test("Windows setup requires explicit approval and confirmed completion; no YOLO fallback", async (t) => {
  const client = new Client();
  client.authenticated = true;
  let saved = false;
  const auth = new CodexAuth("", "", {
    clientFactory: () => client,
    windowsSetup: true,
    onSandboxReady: () => {
      saved = true;
    },
  });
  t.after(() => auth.close());
  await assert.rejects(auth.requireReady(), { status: 428 });
  assert.equal((await auth.start()).sandboxRequired, true);
  await assert.rejects(auth.setupSandbox({}), /Approve/);
  await auth.setupSandbox({ approved: true });
  assert.equal(auth.publicState().sandboxBusy, true);
  client.emit("notification", {
    method: "windowsSandbox/setupCompleted",
    params: { success: false },
  });
  await assert.rejects(auth.requireReady());
  assert.equal(saved, false);
  await auth.setupSandbox({ approved: true });
  client.emit("notification", {
    method: "windowsSandbox/setupCompleted",
    params: { success: true },
  });
  await auth.requireReady();
  assert.equal(saved, true);
  assert.deepEqual(
    client.calls
      .filter((c) => c.method === "windowsSandbox/setupStart")
      .map((c) => c.params),
    [{ mode: "elevated" }, { mode: "elevated" }],
  );
});
test("HTTP start is blocked before mutating a draft; OAuth URLs are not persisted in request journals", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fleet-auth-test-"));
  const client = new Client();
  const app = await createApp({
    dataDir: join(directory, "data"),
    bin: fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)),
    authFactory: (bin, cwd, options) =>
      new CodexAuth(bin, cwd, { ...options, clientFactory: () => client }),
  });
  t.after(async () => {
    await app.close();
    app.store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const s = await fleetFetch(base + "/state").then((r) => r.json());
  const post = (path, value, token = s.csrf) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-fleet-token": token,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(value),
    });
  assert.equal((await post("/auth/login", {}, "")).status, 403);
  assert.equal((await fetch(base + "/auth/status")).status, 403);
  const login = await post("/auth/login", {});
  assert.equal(login.status, 200);
  assert.match((await login.json()).authUrl, /^https:/);
  const project = await app.addProject({
    mode: "create",
    parentPath: directory,
    folderName: "test",
    gitApproved: true,
  });
  const run = app.engine.create(project.id, {
    title: "Preserve draft",
    prompt: "original",
    sandbox: "workspace-write",
  });
  const response = await post(`/runs/${run.id}/start`, {
    prompt: "user draft",
  });
  assert.equal(response.status, 428);
  assert.equal((await response.json()).code, "CODEX_SIGN_IN_REQUIRED");
  assert.equal(app.store.get("run", run.id).status, "draft");
  assert.equal(app.store.get("run", run.id).prompt, "original");
  assert.equal(app.engine.processes.size, 0);
  const journal = JSON.stringify(
    app.store.db.prepare("SELECT * FROM requests").all(),
  );
  assert(!journal.includes("private-login"));
});
