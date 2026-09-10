import { CodexClient } from "./codex-client.mjs";
import { signInMessage, validAuthURL } from "../shared/auth.mjs";

// Codex owns credentials and its OAuth callback. Fleet never reads auth.json,
// accepts passwords, or persists sign-in URLs in its event/request journal.
export class CodexAuth {
  constructor(
    bin,
    cwd,
    {
      clientFactory = () => new CodexClient(bin, cwd),
      onChange = () => {},
      windowsSetup = false,
      sandboxReady = false,
      onSandboxReady = () => {},
    } = {},
  ) {
    this.factory = clientFactory;
    this.onChange = onChange;
    this.state = { authenticated: false, available: true, checking: true };
    this.at = 0;
    this.windowsSetup = windowsSetup;
    this.sandboxReady = sandboxReady;
    this.onSandboxReady = onSandboxReady;
  }
  async connection() {
    if (this.closed) throw new Error("Authentication client is closed.");
    if (!this.connecting) {
      const client = this.factory();
      this.client = client;
      client.on("notification", ({ method, params }) => {
        if (method === "account/login/completed") this.lastCompletion = params;
        if (method === "windowsSandbox/setupCompleted") {
          this.sandboxBusy = false;
          this.sandboxReady = params.success === true;
          this.sandboxError = params.success
            ? null
            : "Windows setup was cancelled or could not finish. Retry and approve the Windows prompt.";
          if (this.sandboxReady) this.onSandboxReady();
          this.onChange();
        }
        if (
          method === "account/login/completed" &&
          this.login &&
          params.loginId === this.login.loginId
        ) {
          this.login = null;
          this.at = 0;
          if (params.success) this.reauth = false;
          if (!params.success)
            this.loginError = "Sign-in did not finish. Try again.";
          this.onChange();
        }
        if (method === "account/updated") {
          this.at = 0;
          this.onChange();
        }
      });
      client.on("closed", () => {
        if (this.client !== client) return;
        this.connecting = null;
        this.client = null;
        this.login = null;
        this.sandboxBusy = false;
        this.at = 0;
      });
      this.connecting = client
        .connect()
        .then(() => client)
        .catch((error) => {
          client.close();
          if (this.client === client) {
            this.connecting = null;
            this.client = null;
          }
          throw error;
        });
    }
    return this.connecting;
  }
  async read(force = false) {
    if (!force && Date.now() - this.at < 5000) return this.publicState();
    if (!this.reading)
      this.reading = (async () => {
        try {
          const client = await this.connection();
          const account = await client.request("account/read", {
            refreshToken: force,
          });
          if (typeof account.requiresOpenaiAuth !== "boolean")
            throw new Error("Invalid account response");
          this.state = {
            available: true,
            checking: false,
            authenticated:
              !this.reauth &&
              (!!account.account || account.requiresOpenaiAuth === false),
          };
          if (this.state.authenticated) this.loginError = null;
        } catch {
          this.state = {
            available: false,
            authenticated: false,
            checking: false,
            error:
              "Codex could not start. Retry setup or reinstall the latest Fleet installer.",
          };
        }
        this.at = Date.now();
        return this.publicState();
      })().finally(() => {
        this.reading = null;
      });
    return this.reading;
  }
  publicState() {
    return {
      ...this.state,
      waiting: !!this.login,
      sandboxRequired: this.windowsSetup && !this.sandboxReady,
      sandboxBusy: !!this.sandboxBusy,
      error: this.sandboxError || this.loginError || this.state.error || null,
    };
  }
  async setupSandbox(input) {
    if (!this.windowsSetup || input.approved !== true)
      throw new Error("Approve Windows sandbox setup first.");
    if (this.sandboxBusy) return this.publicState();
    this.sandboxBusy = true;
    this.sandboxError = null;
    try {
      const client = await this.connection();
      const result = await client.request("windowsSandbox/setupStart", {
        mode: "elevated",
      });
      if (result.started !== true)
        throw new Error("Windows sandbox setup did not start.");
    } catch (e) {
      this.sandboxBusy = false;
      throw e;
    }
    return this.publicState();
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const current = await this.read(true);
      if (current.authenticated) return current;
      if (this.login && Date.now() - this.login.started < 8 * 60_000)
        return { authUrl: this.login.authUrl };
      await this.cancel();
      this.loginError = null;
      const client = await this.connection();
      this.lastCompletion = null;
      const login = await client.request("account/login/start", {
        type: "chatgpt",
      });
      if (!login.loginId || !validAuthURL(login.authUrl))
        throw new Error("Codex returned an invalid sign-in link.");
      this.login = { ...login, started: Date.now() };
      if (this.lastCompletion?.loginId === login.loginId) {
        this.reauth = !this.lastCompletion.success;
        this.login = null;
        this.at = 0;
      }
      return { authUrl: login.authUrl };
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async cancel() {
    const login = this.login;
    this.login = null;
    if (login && this.client)
      await this.client
        .request("account/login/cancel", { loginId: login.loginId })
        .catch(() => {});
  }
  async requireReady() {
    const state = await this.read(true);
    if (!state.authenticated)
      throw Object.assign(
        new Error(state.available ? signInMessage : state.error),
        { status: 428, code: "CODEX_SIGN_IN_REQUIRED" },
      );
    if (state.sandboxRequired)
      throw Object.assign(
        new Error(
          "Finish Windows setup in Fleet before starting a task. Your draft has been kept.",
        ),
        { status: 428, code: "CODEX_SIGN_IN_REQUIRED" },
      );
  }
  invalidate() {
    this.reauth = true;
    this.at = 0;
    this.state.authenticated = false;
    this.onChange();
  }
  async close() {
    this.closed = true;
    await this.client?.close();
    await Promise.allSettled([this.connecting, this.reading, this.starting]);
  }
}
