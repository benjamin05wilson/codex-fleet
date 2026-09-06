export type RunStatus =
  | "draft"
  | "queued"
  | "preparing"
  | "running"
  | "pausing"
  | "paused"
  | "interrupted"
  | "failed"
  | "review"
  | "validating"
  | "accepting"
  | "accepted"
  | "cancelled";
export type Sandbox = "read-only" | "workspace-write";
export interface SessionDefaults {
  sandbox: Sandbox;
  model: string;
  useTeam: boolean;
}
export interface QuickSessionInput extends Partial<SessionDefaults> {
  projectId?: string | null;
  prompt?: string;
  approved: boolean;
  rememberDefaults?: boolean;
}
export interface NewWorkspaceSessionInput {
  projectId: string;
  kind: "main" | "worktree" | "terminal";
  approved: boolean;
}
export interface PlanTask {
  title: string;
  prompt: string;
  scopes: string[];
  dependencies: number[];
}
export interface WorkflowInput {
  title: string;
  objective: string;
  templateId: "implement" | "investigate" | "review";
  tasks?: PlanTask[];
}
export interface Workflow extends WorkflowInput {
  id: string;
  projectId: string;
  status: "draft" | "running" | "needs-review" | "needs-attention" | "complete";
  approvedAt?: string;
  runIds?: string[];
  limits: {
    concurrency: number;
    maxTasks: number;
    maxAttempts: number;
    timeoutMs: number;
  };
}
export interface ContextSelection {
  text: string;
  budget: number;
  notes: {
    filename: string;
    source: string | null;
    characters: number;
    pinned: boolean;
    score: number;
  }[];
  omitted: { filename: string; reason: string }[];
}
export interface FleetEvent {
  seq: number;
  runId: string | null;
  projectId: string;
  time: string;
  type: string;
  data: unknown;
}
export interface Capabilities {
  apiVersion: 1;
  transport: string;
  stream: "sse";
  codexTerminal: { available: boolean; reason?: string };
  shell: boolean;
  quickSessions: boolean;
  sessionFiles: boolean;
  sandboxedChecks: boolean;
  workflows: boolean;
  projectTeams: boolean;
  limits: {
    concurrency: number;
    tasks: number;
    attempts: number;
    timeoutMs: number;
  };
}
export type TeamRole = "developer" | "security" | "verification" | "memory";
export interface ProjectTeam {
  id: string;
  projectId: string;
  roles: TeamRole[];
  members: Partial<Record<TeamRole, string>>;
  enabled: boolean;
  maxRounds: number;
  roundsUsed: number;
  timeoutMs: number;
  approvedAt: string;
  reason?: string;
}
export interface TeamFinding {
  title: string;
  file: string;
  line: number;
  severity: "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  evidence: string;
  verification: string;
}
export interface RequestOptions {
  requestId?: string;
}
export interface LocalClient {
  setToken(value: string): void;
  request<T = unknown>(
    path: string,
    method?: string,
    data?: unknown,
    options?: RequestOptions,
  ): Promise<T>;
}
