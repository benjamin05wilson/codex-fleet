import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { basename, join, extname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store, id, now } from "./store.mjs";
import { Brain } from "./brain.mjs";
import { Engine } from "./engine.mjs";
import { repository, changes, inside } from "./git.mjs";
import { redact } from "./sentinel.mjs";
import { discoverCodex } from "./discovery.mjs";
import { prepareProject, inspectProject } from "./projects.mjs";
import { reviewImport, importProject } from "./imports.mjs";
import { Previews } from "./previews.mjs";
import {
  quickSession,
  newWorkspaceSession,
  deleteSession,
  restoreSession,
  sessionFiles,
  updateSessionOptions,
} from "./workspace.mjs";
import { limits } from "./limits.mjs";
import { Terminals } from "./terminals.mjs";
import { Workflows, templates } from "./workflows.mjs";
import { Teams, teamRoles, teamDefaults } from "./teams.mjs";
import { searchWorkspace, previewFile } from "./search.mjs";
import { onboardingSettings, saveOnboarding } from "./onboarding.mjs";
import { NativeBrowserBroker } from "./native-browser-broker.mjs";
import { commandInvocation } from "../shared/platform.mjs";
import { CodexAuth } from "./auth.mjs";

const exec = promisify(execFile);
async function body(req, maxBytes = 100_000) {
  if (req.fleetBody !== undefined) return req.fleetBody;
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > maxBytes)
      throw Object.assign(new Error("Request too large"), { status: 413 });
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Error("Invalid JSON");
  }
}
export async function createApp({
  dataDir,
  staticDir,
  bin,
  concurrency = 3,
  transport = "app-server",
  browserOptions,
  browserFactory = (engine) => new NativeBrowserBroker(engine),
  authFactory = (bin, cwd, options) => new CodexAuth(bin, cwd, options),
}) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(join(dataDir, "fleet.sqlite"));
  const brain = new Brain(store, dataDir);
  const engine = new Engine(store, brain, dataDir, {
    bin,
    concurrency,
    transport,
  });
  const auth = authFactory(engine.bin, dataDir, {
    onChange: () => {
      discoveryCache = null;
      statusAt = 0;
    },
    windowsSetup:
      process.platform === "win32" && process.env.FLEET_MANAGED_TOOLS === "1",
    sandboxReady: store
      .list("preferences")
      .some((p) => p.id === "windows-sandbox" && p.ready),
    onSandboxReady: () =>
      store.put("preferences", {
        id: "windows-sandbox",
        ready: true,
        completedAt: now(),
      }),
  });
  engine.auth = auth;
  const terminals = new Terminals(engine);
  engine.terminals = terminals;
  const previews = new Previews(engine);
  engine.previews = previews;
  const browsers = browserFactory(engine, browserOptions);
  engine.browsers = browsers;
  const workflows = new Workflows(store, engine);
  const teams = new Teams(store, engine, brain);
  engine.teams = teams;
  const streams = new Set();
  const csrf = randomBytes(32).toString("hex");
  let discoveryPending, discoveryCache;
  async function codexMetadata(refresh = false) {
    if (!refresh && discoveryCache && Date.now() - discoveryCache.at < 60_000)
      return discoveryCache.value;
    if (!discoveryPending)
      discoveryPending = discoverCodex(
        bin || process.env.FLEET_CODEX_BIN || "codex",
        dataDir,
      )
        .then((value) => {
          discoveryCache = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          discoveryPending = null;
        });
    return discoveryPending;
  }
  let inventoryBusy = false,
    closing = false;
  async function refreshInventories() {
    if (inventoryBusy || closing) return;
    inventoryBusy = true;
    try {
      for (const project of store.list("project")) {
        if (closing) break;
        try {
          const current = await repository(project.path);
          store.patch("project", project.id, {
            ...current,
            inventoryError: null,
          });
          if (current.head !== project.brainHead)
            await brain.refresh({ ...project, ...current });
        } catch (e) {
          store.patch("project", project.id, {
            inventoryError: redact(e.message),
          });
        }
      }
    } finally {
      inventoryBusy = false;
    }
  }
  const inventoryTimer = setInterval(refreshInventories, 20_000);
  let statusCache = null,
    statusAt = 0;
  async function status() {
    if (statusCache && Date.now() - statusAt < 30_000) return statusCache;
    const command = bin || process.env.FLEET_CODEX_BIN || "codex";
    let version = null,
      authenticated = false,
      message = "Codex is not available in PATH.";
    try {
      const invoke = (args) => {
        const call = commandInvocation(command, args);
        return exec(call.bin, call.args, { timeout: 5000, windowsHide: true });
      };
      version = (await invoke(["--version"])).stdout.trim();
      try {
        const account = await auth.read();
        authenticated = account.authenticated;
        message = authenticated
          ? "Signed in to Codex."
          : "Sign in to Codex to continue.";
      } catch {
        message = "Sign in to Codex to continue.";
      }
    } catch {}
    statusAt = Date.now();
    return (statusCache = {
      ...auth.publicState(),
      version,
      authenticated,
      message,
      concurrency: engine.concurrency,
      dataDir,
    });
  }
  async function addProject(input) {
    if (
      input.firstTask &&
      (input.firstTask.approved !== true ||
        typeof input.firstTask.prompt !== "string" ||
        !input.firstTask.prompt.trim() ||
        input.firstTask.prompt.length > 30000)
    )
      throw new Error(
        "Approve a first task with an instruction of up to 30,000 characters.",
      );
    const repo =
      input.mode === "import"
        ? await importProject(input, dataDir)
        : await prepareProject(input);
    const duplicate = store.list("project").find((p) => p.path === repo.path);
    if (duplicate) {
      if (input.firstTask)
        throw new Error(
          "This project is already connected. Open it and assign the task with New session.",
        );
      return duplicate;
    }
    const project = store.put("project", {
      id: id(),
      name: String(input.name || basename(repo.sourcePath || repo.path)).slice(
        0,
        100,
      ),
      ...repo,
      validation: input.validation || "",
      createdAt: now(),
      example: false,
    });
    await brain.refresh(project);
    if (input.team?.approved === true) {
      const enabledTeam = await teams.enable(project.id, input.team, {
        deferInitial: !!input.firstTask,
      });
      if (!enabledTeam.enabled) {
        return store.patch("project", project.id, {
          setupError: `Team setup failed: ${enabledTeam.reason || "unknown reason"}. No first task was started.`,
        });
      }
    }
    if (input.firstTask) {
      const task = {
        title: input.firstTask.prompt.trim().split("\n")[0].slice(0, 100),
        prompt: input.firstTask.prompt.trim(),
        sandbox: "workspace-write",
      };
      try {
        const run = teams.get(project.id)?.enabled
          ? await teams.task(project.id, task)
          : engine.queue(engine.create(project.id, task).id);
        store.patch("project", project.id, { firstRunId: run.id });
      } catch (e) {
        store.patch("project", project.id, { setupError: redact(e.message) });
      }
    }
    store.event(project.id, null, "project.added", { name: project.name });
    return store.get("project", project.id);
  }
  const server = createServer(async (req, res) => {
    let requestKey;
    const send = (value, code = 200) => {
      if (requestKey)
        store.db
          .prepare(
            "UPDATE requests SET status='complete',response=? WHERE key=?",
          )
          .run(JSON.stringify({ value, code }), requestKey);
      res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      const port = server.address()?.port;
      if (
        ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)
      ) {
        send({ error: "Invalid host" }, 403);
        return;
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      const origin = `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== origin) {
        send({ error: "Cross-origin requests are not allowed" }, 403);
        return;
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src http://127.0.0.1:*; object-src 'none'; frame-ancestors 'none'",
      );
      const path = url.pathname;
      if (path.startsWith("/api/")) {
        const nativeMatch = path.match(
          /^\/api\/native-browser\/(register|launcher-register|next|result|close)$/,
        );
        if (nativeMatch) {
          if (req.method !== "POST" || req.headers["x-fleet-token"] !== csrf) {
            send({ error: "Native desktop authentication required." }, 403);
            return;
          }
          const action = nativeMatch[1];
          const input = await body(
            req,
            action === "result" ? 12500000 : 100000,
          );
          if (action === "register") send(browsers.register(input));
          if (action === "launcher-register")
            send(browsers.registerLauncher(input));
          if (action === "result") send(browsers.result(input.token, input));
          if (action === "close") send(browsers.disconnect(input.token));
          if (action === "next") {
            const controller = new AbortController();
            res.once("close", () => controller.abort());
            const command = await browsers.next(input.token, controller.signal);
            if (!res.destroyed) send(command);
          }
          return;
        }
        if (path === "/api/browser-agent" && req.method === "POST") {
          send(
            await browsers.agent(
              String(req.headers.authorization || "").replace(/^Bearer /, ""),
              await body(req),
            ),
          );
          return;
        }
        if (req.method === "GET" && path === "/api/search") {
          send(
            await searchWorkspace(
              store,
              brain,
              url.searchParams.get("q") || "",
              url.searchParams.get("projectId"),
              url.searchParams.get("includeExamples") === "1",
            ),
          );
          return;
        }
        const fileMatch = path.match(/^\/api\/projects\/([^/]+)\/file$/);
        if (req.method === "GET" && fileMatch) {
          send(
            await previewFile(
              store.get("project", fileMatch[1]),
              url.searchParams.get("path"),
            ),
          );
          return;
        }
        if (
          !["GET", "HEAD"].includes(req.method) &&
          req.headers["x-fleet-token"] !== csrf
        ) {
          send({ error: "Reload Fleet to refresh your local session." }, 403);
          return;
        }
        if (
          !["GET", "HEAD"].includes(req.method) &&
          req.headers["idempotency-key"] &&
          !path.startsWith("/api/auth/") &&
          !/^\/api\/projects\/[^/]+\/browser(?:\/|$)/.test(path)
        ) {
          const key = String(req.headers["idempotency-key"]);
          if (key.length > 128) throw new Error("Invalid request identity.");
          const payload = await body(req);
          req.fleetBody = payload;
          const fingerprint = createHash("sha256")
            .update(req.method + path + JSON.stringify(payload))
            .digest("hex");
          const previous = store.db
            .prepare("SELECT * FROM requests WHERE key=?")
            .get(key);
          if (previous) {
            if (previous.fingerprint !== fingerprint) {
              send(
                { error: "Request identity was reused for different input." },
                409,
              );
              return;
            }
            if (previous.status !== "complete") {
              send(
                {
                  error:
                    "This request is in progress or needs reconciliation; it will not be executed twice.",
                },
                409,
              );
              return;
            }
            const saved = JSON.parse(previous.response);
            send(saved.value, saved.code);
            return;
          }
          store.db
            .prepare("INSERT INTO requests VALUES(?,?,'pending',NULL)")
            .run(key, fingerprint);
          requestKey = key;
        }
        const sessionTarget = path.match(/^\/api\/runs\/([^/]+)(?:\/(.*))?$/);
        if (sessionTarget) {
          const target = store.get("run", sessionTarget[1]);
          if (
            target.deletedAt &&
            sessionTarget[2] !== "restore" &&
            req.method !== "DELETE"
          ) {
            send(
              {
                error:
                  "This chat is in Trash. Restore it before opening or running it.",
              },
              410,
            );
            return;
          }
        }
        const browserMatch = path.match(
          /^\/api\/projects\/([^/]+)\/browser(?:\/(start|stop|control|take|grant|approve|frame|frames|tabs))?$/,
        );
        if (browserMatch) {
          if (req.headers["x-fleet-token"] !== csrf) {
            send({ error: "Reload Fleet to access the project browser." }, 403);
            return;
          }
          const [, projectId, action] = browserMatch;
          const clientId = req.headers["x-fleet-client"];
          if (
            !clientId ||
            typeof clientId !== "string" ||
            clientId.length > 128
          )
            throw new Error("Browser client identity is required.");
          if (req.method === "GET" && !action)
            send(browsers.state(projectId, clientId));
          else if (req.method === "GET" && action === "frame")
            send(browsers.frame(projectId));
          else if (req.method === "GET" && action === "frames")
            browsers.streamFrames(projectId, res);
          else if (req.method === "GET" && action === "tabs")
            send(await browsers.tabs(projectId));
          else if (req.method === "POST") {
            const input = await body(req);
            if (action === "start")
              send(await browsers.start(projectId, input, clientId));
            else if (action === "stop") send(await browsers.stop(projectId));
            else if (action === "take")
              send(browsers.take(projectId, clientId));
            else if (action === "grant")
              send(
                browsers.grant(
                  projectId,
                  input.runId,
                  clientId,
                  input.approved,
                ),
              );
            else if (action === "approve")
              send(browsers.approve(projectId, input, clientId));
            else if (action === "control")
              send(await browsers.control(projectId, input, clientId));
            else send({ error: "Unsupported browser action." }, 405);
          } else send({ error: "Method not allowed." }, 405);
          return;
        }
        if (req.method === "GET" && path === "/api/capabilities") {
          send({
            apiVersion: 1,
            transport,
            stream: "sse",
            codexTerminal: {
              available: false,
              reason:
                "Native Codex TUI handoff is not compatibility-certified; use the worktree shell.",
            },
            shell: true,
            quickSessions: true,
            sessionFiles: true,
            sandboxedChecks: true,
            workflows: true,
            projectTeams: transport === "app-server",
            limits: { concurrency: engine.concurrency, ...limits },
          });
          return;
        }
        if (req.method === "GET" && path === "/api/stream") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          });
          streams.add(res);
          let cursor = Number(
            req.headers["last-event-id"] || url.searchParams.get("after") || 0,
          );
          if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
          let batch;
          do {
            batch = store.replay(cursor);
            for (const e of batch) {
              res.write(
                `id: ${e.seq}\nevent: change\ndata: ${JSON.stringify(e)}\n\n`,
              );
              cursor = e.seq;
            }
          } while (batch.length === 500);
          const listener = (change) => {
            if (change.kind !== "event")
              res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
          };
          const eventListener = (e) =>
            res.write(
              `id: ${e.seq}\nevent: change\ndata: ${JSON.stringify(e)}\n\n`,
            );
          store.changes.on("change", listener);
          store.changes.on("event", eventListener);
          const heartbeat = setInterval(
            () => res.write(": keepalive\n\n"),
            15000,
          );
          req.on("close", () => {
            clearInterval(heartbeat);
            store.changes.off("change", listener);
            store.changes.off("event", eventListener);
            streams.delete(res);
          });
          return;
        }
        if (path.startsWith("/api/auth/")) {
          if (req.headers["x-fleet-token"] !== csrf) {
            send({ error: "Reload Fleet to sign in." }, 403);
            return;
          }
          res.setHeader("Cache-Control", "no-store");
          if (path === "/api/auth/status" && req.method === "GET")
            send(await auth.read());
          else if (path === "/api/auth/login" && req.method === "POST")
            send(await auth.start());
          else if (path === "/api/auth/cancel" && req.method === "POST") {
            await auth.cancel();
            send({ ok: true });
          } else if (path === "/api/auth/refresh" && req.method === "POST") {
            statusAt = 0;
            send(await auth.read(true));
          } else if (
            path === "/api/auth/windows-setup" &&
            req.method === "POST"
          )
            send(await auth.setupSandbox(await body(req)));
          else send({ error: "Unknown sign-in action" }, 404);
          return;
        }
        if (req.method === "POST" && path === "/api/onboarding") {
          send(saveOnboarding(store, await body(req)));
          return;
        }
        if (req.method === "GET" && path === "/api/state") {
          const allRuns = store.list("run");
          const runs = allRuns
            .filter((r) => !r.deletedAt)
            .map(({ validation, ...r }) => ({
              ...r,
              validation: validation
                ? { ...validation, diff: undefined, output: undefined }
                : null,
            }));
          send({
            csrf,
            browserAvailable: false,
            browserMode: "native",
            browserDesktopOnly: true,
            browserAgentAvailable: true,
            browserAutoOpenAvailable: !!browsers.launcher,
            onboarding: onboardingSettings(store),
            projects: store.list("project"),
            runs,
            deletedRuns: allRuns
              .filter((r) => r.deletedAt && r.deletionRootId === r.id)
              .map(({ id, title, projectId, sessionKind, deletedAt }) => ({
                id,
                title,
                projectId,
                sessionKind,
                deletedAt,
              })),
            missions: store.list("mission"),
            workflows: store.list("workflow"),
            workitems: store.list("workitem"),
            findings: store
              .list("finding")
              .filter(
                (f) => !allRuns.some((r) => r.id === f.runId && r.deletedAt),
              ),
            status: await status(),
            limits: { concurrency: engine.concurrency, ...limits },
            workflowTemplates: templates,
            teams: store.list("team"),
            scratchDefaults: store
              .list("preferences")
              .find((p) => p.id === "scratch-session") || {
              sandbox: "read-only",
              model: "",
              useTeam: false,
            },
            teamRounds: store.list("team-round"),
            teamConfig: { roles: teamRoles, defaults: teamDefaults },
          });
          return;
        }
        if (req.method === "GET" && path === "/api/workflow-templates") {
          send(templates);
          return;
        }
        const teamMatch = path.match(
          /^\/api\/projects\/([^/]+)\/team(?:\/(pause|renew|task|review|acknowledge|fix))?$/,
        );
        if (teamMatch && req.method === "POST") {
          const projectId = teamMatch[1],
            action = teamMatch[2],
            input = await body(req);
          send(
            !action
              ? await teams.enable(projectId, input)
              : action === "task"
                ? await teams.task(projectId, input)
                : action === "review"
                  ? await teams.review(projectId, input.runId)
                  : action === "acknowledge"
                    ? teams.acknowledge(projectId, input.roundId, input.reason)
                    : action === "fix"
                      ? await teams.fix(projectId, input.roundId)
                      : await teams.control(projectId, action, input),
          );
          return;
        }
        const workflowMatch = path.match(
          /^\/api\/workflows\/([^/]+)\/approve$/,
        );
        if (workflowMatch && req.method === "POST") {
          send(workflows.approve(workflowMatch[1]));
          return;
        }
        const terminalMatch = path.match(
          /^\/api\/runs\/([^/]+)\/terminal(?:\/(open|input|resize|close))?$/,
        );
        if (terminalMatch) {
          const run = store.get("run", terminalMatch[1]),
            action = terminalMatch[2];
          if (req.method === "GET" && !action) {
            const s = terminals.get(run.id);
            send({
              events: s.events.filter(
                (e) => e.seq > Number(url.searchParams.get("after") || 0),
              ),
              exitCode: s.exitCode,
            });
            return;
          }
          if (req.method === "POST") {
            const input = await body(req);
            send(
              action === "open"
                ? await terminals.open(
                    run,
                    req.headers["x-fleet-client"] || "local-client",
                  )
                : terminals.control(run.id, input.lease, action, input),
            );
            return;
          }
        }
        if (req.method === "POST" && path === "/api/projects") {
          send(await addProject(await body(req)), 201);
          return;
        }
        if (req.method === "POST" && path === "/api/sessions/new") {
          send(
            await newWorkspaceSession({ store, engine }, await body(req)),
            201,
          );
          return;
        }
        if (req.method === "POST" && path === "/api/sessions/quick") {
          send(
            await quickSession(
              { store, engine, brain, teams },
              await body(req),
            ),
            201,
          );
          return;
        }
        const sessionFileMatch = path.match(/^\/api\/runs\/([^/]+)\/files$/);
        if (req.method === "GET" && sessionFileMatch) {
          send(
            await sessionFiles(
              store.get("run", sessionFileMatch[1]),
              url.searchParams.has("path")
                ? url.searchParams.get("path")
                : undefined,
            ),
          );
          return;
        }
        if (req.method === "GET" && path === "/api/codex") {
          send(await codexMetadata(url.searchParams.get("refresh") === "1"));
          return;
        }
        if (req.method === "POST" && path === "/api/repository/inspect") {
          send(await inspectProject((await body(req)).path));
          return;
        }
        if (req.method === "POST" && path === "/api/repository/snapshot") {
          send(await reviewImport((await body(req)).path));
          return;
        }
        const previewMatch = path.match(
          /^\/api\/runs\/([^/]+)\/preview\/(start|stop)$/,
        );
        if (req.method === "POST" && previewMatch) {
          const run = store.get("run", previewMatch[1]);
          send(
            previewMatch[2] === "start"
              ? await previews.start(run, await body(req), [port])
              : await previews.stop(run.id),
          );
          return;
        }
        const projectMatch = path.match(
          /^\/api\/projects\/([^/]+)(?:\/(brain|notes|runs|missions|activity|conflicts|context|workflows|approve-note))?$/,
        );
        if (projectMatch) {
          const project = store.get("project", projectMatch[1]);
          const action = projectMatch[2];
          if (action === "workflows" && req.method === "POST") {
            send(workflows.create(project.id, await body(req)), 201);
            return;
          }
          if (action === "context" && req.method === "GET") {
            const runId = url.searchParams.get("runId");
            const run = runId ? store.get("run", runId) : null;
            if (run && run.projectId !== project.id)
              throw new Error("Session belongs to another project.");
            send(
              run?.contextSelection ||
                (await brain.selectContext(
                  project,
                  url.searchParams.get("q") || run?.prompt || "",
                  run?.contextOptions || {},
                )),
            );
            return;
          }
          if (action === "approve-note" && req.method === "POST") {
            await brain.approve(project, (await body(req)).filename);
            send({ ok: true });
            return;
          }
          if (req.method === "PATCH" && !action) {
            const input = await body(req);
            if (
              input.contextPreferences &&
              !["pinned", "excluded"].every(
                (key) =>
                  Array.isArray(input.contextPreferences[key]) &&
                  input.contextPreferences[key].every(
                    (n) =>
                      typeof n === "string" && /^[a-zA-Z0-9 _.-]+\.md$/.test(n),
                  ),
              )
            )
              throw new Error("Invalid context preferences.");
            const updated = store.patch("project", project.id, {
              ...(input.contextPreferences
                ? { contextPreferences: input.contextPreferences }
                : {}),
              name: String(input.name || project.name).slice(0, 100),
              validation: String(input.validation ?? project.validation).slice(
                0,
                1000,
              ),
            });
            await brain.refresh(updated);
            send(store.get("project", project.id));
            return;
          }
          if (action === "brain" && req.method === "GET") {
            send({
              notes: await brain.list(project),
              vaultPath: brain.path(project),
            });
            return;
          }
          if (action === "brain" && req.method === "POST") {
            send({
              notes: await brain.refresh(project),
              vaultPath: brain.path(project),
            });
            return;
          }
          if (action === "notes" && req.method === "POST") {
            const input = await body(req);
            const filename = String(input.filename || "");
            if (
              ["Home.md", "Repository map.md", "Development.md"].includes(
                filename,
              ) ||
              filename.startsWith("Session ")
            )
              throw new Error(
                "Generated notes are managed by Fleet. Create a separate decision note.",
              );
            await brain.write(project, filename, String(input.content || ""));
            store.event(project.id, null, "brain.note.saved", { filename });
            send({ ok: true });
            return;
          }
          if (action === "runs" && req.method === "POST") {
            send(engine.create(project.id, await body(req)), 201);
            return;
          }
          if (action === "missions" && req.method === "POST") {
            const input = await body(req);
            if (
              !input.title?.trim() ||
              !Array.isArray(input.tasks) ||
              input.tasks.length < 1 ||
              input.tasks.length > 12
            )
              throw new Error("A mission needs a title and 1–12 tasks.");
            if (
              input.tasks.some(
                (t) =>
                  !t.title?.trim() ||
                  !t.prompt?.trim() ||
                  t.title.length > 160 ||
                  t.prompt.length > 30_000,
              )
            )
              throw new Error("Every task needs a title and a valid prompt.");
            if (
              !["read-only", "workspace-write"].includes(
                input.sandbox || "read-only",
              )
            )
              throw new Error("Invalid sandbox.");
            const mission = store.put("mission", {
              id: id(),
              projectId: project.id,
              title: input.title.trim().slice(0, 160),
              objective: input.objective || "",
              createdAt: now(),
              sequential: !!input.sequential,
            });
            let previous = null;
            for (const task of input.tasks) {
              const run = engine.create(project.id, {
                ...task,
                prompt: `Mission: ${mission.title}\n${mission.objective}\n\nTask: ${task.prompt}`,
                missionId: mission.id,
                sandbox: input.sandbox || "read-only",
                dependencies: input.sequential && previous ? [previous] : [],
              });
              previous = run.id;
            }
            send(mission, 201);
            return;
          }
          if (action === "activity" && req.method === "GET") {
            send(store.events({ projectId: project.id, limit: 300 }));
            return;
          }
          if (action === "conflicts" && req.method === "GET") {
            send(engine.conflicts(project.id));
            return;
          }
        }
        const runMatch = path.match(
          /^\/api\/runs\/([^/]+)(?:\/(start|pause|cancel|diff|validate|accept|review|options|restore))?$/,
        );
        if (runMatch) {
          const key = runMatch[1];
          const run = store.get("run", key);
          const action = runMatch[2];
          if (req.method === "DELETE" && !action) {
            send(deleteSession({ store, engine }, key, await body(req)));
            return;
          }
          if (req.method === "POST" && action === "restore") {
            send(restoreSession({ store, engine }, key));
            return;
          }
          if (req.method === "POST" && action === "options") {
            send(updateSessionOptions({ store, engine }, key, await body(req)));
            return;
          }
          if (req.method === "GET" && !action) {
            const { diff, ...validation } = run.validation || {};
            const before = Number(
              url.searchParams.get("before") || Number.MAX_SAFE_INTEGER,
            );
            if (!Number.isSafeInteger(before) || before < 0)
              throw new Error("Invalid event cursor.");
            const events = store.events({ runId: key, before, limit: 600 });
            send({
              ...run,
              validation: run.validation ? validation : null,
              events,
              hasEarlierEvents:
                events.length > 0 &&
                store.events({ runId: key, before: events[0].seq, limit: 1 })
                  .length > 0,
            });
            return;
          }
          if (req.method === "GET" && action === "diff") {
            const change = await changes(run);
            send({ ...change, diff: redact(change.diff) });
            return;
          }
          if (req.method === "POST" && action === "start") {
            await auth.requireReady();
            const input = await body(req);
            send(engine.queue(key, input.prompt));
            return;
          }
          if (req.method === "POST" && action === "pause") {
            send(engine.stop(key));
            return;
          }
          if (req.method === "POST" && action === "cancel") {
            send(engine.stop(key, "cancelled"));
            return;
          }
          if (req.method === "POST" && action === "validate") {
            send(await engine.validate(key, await body(req)));
            return;
          }
          if (req.method === "POST" && action === "accept") {
            send(await engine.accept(key));
            return;
          }
          if (req.method === "POST" && action === "review") {
            send(engine.review(key), 201);
            return;
          }
        }
        const missionMatch = path.match(/^\/api\/missions\/([^/]+)\/start$/);
        if (missionMatch && req.method === "POST") {
          store.get("mission", missionMatch[1]);
          for (const r of store
            .list("run")
            .filter(
              (r) => r.missionId === missionMatch[1] && r.status === "draft",
            ))
            engine.queue(r.id);
          send({ ok: true });
          return;
        }
        const findingMatch = path.match(/^\/api\/findings\/([^/]+)$/);
        if (findingMatch && req.method === "PATCH") {
          const input = await body(req);
          if (
            !["accepted-risk", "false-positive", "suspected"].includes(
              input.state,
            )
          )
            throw new Error("Invalid finding state.");
          if (input.state !== "suspected" && !input.reason?.trim())
            throw new Error("Record a reason for this decision.");
          const f = store.patch("finding", findingMatch[1], {
            state: input.state,
            reason: input.reason || "",
          });
          store.event(f.projectId, f.runId, "sentinel.resolved", {
            id: f.id,
            state: f.state,
            reason: f.reason,
          });
          send(f);
          return;
        }
        send({ error: "API endpoint not found" }, 404);
        return;
      }
      if (req.method !== "GET") {
        send({ error: "Method not allowed" }, 405);
        return;
      }
      let target = resolve(staticDir, "." + decodeURIComponent(path));
      if (!inside(staticDir, target)) {
        send({ error: "Not found" }, 404);
        return;
      }
      if (path === "/" || !extname(path))
        target = join(staticDir, "index.html");
      const content = await readFile(target);
      const type =
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".woff2": "font/woff2",
        }[extname(target)] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": type,
        "Cache-Control":
          extname(target) === ".html" ? "no-store" : "public, max-age=3600",
      });
      res.end(content);
    } catch (e) {
      send(
        {
          error: redact(e.message),
          ...(e.code === "CODEX_SIGN_IN_REQUIRED" ? { code: e.code } : {}),
        },
        e.status || 400,
      );
    }
  });
  browsers.base = () =>
    server.address() ? `http://127.0.0.1:${server.address().port}` : "";
  return {
    server,
    store,
    engine,
    brain,
    teams,
    previews,
    browsers,
    addProject,
    refreshInventories,
    close: async ({ preserveWorkers = false } = {}) => {
      closing = true;
      auth.close();
      clearInterval(inventoryTimer);
      workflows.close();
      await teams.close();
      await previews.close();
      await browsers.close();
      terminals.close();
      for (const stream of streams) stream.end();
      engine.shutdown({ preserveWorkers });
      // File edits can leave an in-flight security scan after its watcher stops.
      // Drain it while SQLite is still available.
      await Promise.allSettled([...engine.scans]);
      await Promise.all(
        [...engine.validations.values()].map((v) => v.pending).filter(Boolean),
      );
      await new Promise((resolve) => {
        server.close(resolve);
        // SSE is ended and validation is settled above; incomplete/idle HTTP
        // clients must not keep an otherwise stopped daemon alive indefinitely.
        server.closeAllConnections();
      });
      while (inventoryBusy)
        await new Promise((resolve) => setTimeout(resolve, 25));
    },
  };
}
