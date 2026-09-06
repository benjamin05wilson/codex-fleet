import React, { useState } from "react";
import { api, Button, Field, MD, Status } from "../ui.jsx";

export function TeamApproval({ config, value, onChange }) {
  if (!config)
    return (
      <p className="muted-copy">
        Team setup is unavailable until daemon capabilities load.
      </p>
    );
  const options = { ...config.defaults, ...value };
  return (
    <fieldset className="team-approval">
      <legend>Project team</legend>
      <p className="muted-copy">
        Developer, Security and Verification keep separate Codex histories.
        Existing code starts with a read-only assessment; empty projects wait
        for your first task. Only a task you assign can enable developer edits.
      </p>
      <label className="check-label">
        <input
          type="checkbox"
          checked={options.roles.includes("memory")}
          onChange={(e) =>
            onChange({
              ...options,
              roles: e.target.checked
                ? [...options.roles, "memory"]
                : options.roles.filter((r) => r !== "memory"),
            })
          }
        />{" "}
        Include Memory proposals
      </label>
      <div className="team-budget-fields">
        <Field label="Review rounds">
          <input
            type="number"
            min="1"
            max="20"
            value={options.maxRounds}
            onChange={(e) =>
              onChange({ ...options, maxRounds: Number(e.target.value) })
            }
          />
        </Field>
        <Field label="Minutes per assessment">
          <input
            type="number"
            min="1"
            max="15"
            value={options.timeoutMinutes}
            onChange={(e) =>
              onChange({ ...options, timeoutMinutes: Number(e.target.value) })
            }
          />
        </Field>
      </div>
      <p className="muted-copy">
        Includes the initial assessment. Each later round wakes Security and
        Verification after a completed implementation; optional Memory wakes
        after acceptance. No automatic fixes or failed-review retries. Model
        usage counts towards your Codex account’s usage.
      </p>
      <label className="check-label">
        <input
          type="checkbox"
          checked={!!options.approved}
          onChange={(e) => onChange({ ...options, approved: e.target.checked })}
        />{" "}
        Approve these sessions, read-only reviews and this bounded budget
      </label>
    </fieldset>
  );
}

export function TeamSettings({ project, state, act, busy }) {
  const team = state.teams?.find((t) => t.projectId === project.id);
  const [options, setOptions] = useState({ approved: false });
  if (!team)
    return (
      <section className="team-settings">
        <TeamApproval
          config={state.teamConfig}
          value={options}
          onChange={setOptions}
        />
        <Button
          disabled={busy || !options.approved}
          onClick={() =>
            act(
              () => api(`/projects/${project.id}/team`, "POST", options),
              "Project team enabled. Empty projects wait for your first task.",
            )
          }
        >
          Enable project team
        </Button>
      </section>
    );
  return (
    <section className="team-settings">
      <h3>Project team</h3>
      <p>
        {team.enabled ? "Enabled" : "Paused"} · {team.roundsUsed} /{" "}
        {team.maxRounds} review rounds used ·{" "}
        {Math.round(team.timeoutMs / 60000)} minutes per assessment
      </p>
      <p className="muted-copy">
        Team members reuse their Codex threads. Reviews do not edit code or
        automatically certify changes.
      </p>
      {team.reason && <p role="status">{team.reason}</p>}
      <div className="team-actions">
        {team.enabled && (
          <Button
            disabled={busy}
            onClick={() =>
              act(() => api(`/projects/${project.id}/team/pause`, "POST", {}))
            }
          >
            Pause watchers
          </Button>
        )}
        <Button
          disabled={busy}
          onClick={() =>
            act(() =>
              api(`/projects/${project.id}/team/renew`, "POST", {
                approved: true,
              }),
            )
          }
        >
          Approve {state.teamConfig?.defaults.maxRounds || "more"} more rounds &
          enable
        </Button>
      </div>
      <p className="muted-copy">
        Pausing stops assessments and disables the team acceptance gate; your
        manually assigned coding task is not stopped.
      </p>
    </section>
  );
}

export function TeamStrip({ team, state, goRun, onSettings }) {
  if (!team) return null;
  return (
    <section className="team-strip" aria-label="Project team">
      <div className="team-strip-title">
        <span>Project team</span>
        <button onClick={onSettings}>
          {team.enabled
            ? `${Math.max(0, team.maxRounds - team.roundsUsed)} rounds left`
            : "Paused"}
        </button>
      </div>
      {Object.entries(team.members).map(([role, runId]) => {
        const run = state.runs.find((r) => r.id === runId);
        return (
          <button
            className="team-member"
            key={role}
            onClick={() => goRun(runId)}
          >
            <span>{role}</span>
            <span>
              {run && ["review", "accepted"].includes(run.status)
                ? "Idle"
                : run?.status || "Unavailable"}
            </span>
          </button>
        );
      })}
      {team.reason && (
        <button className="team-reason" onClick={onSettings}>
          {team.reason}
        </button>
      )}
    </section>
  );
}

export function TeamBadge({
  projectId,
  runId,
  state,
  goRun,
  onSettings,
  quiet = false,
}) {
  const team = state.teams?.find((t) => t.projectId === projectId);
  if (!team) return null;
  const round = (state.teamRounds || []).find((r) => r.targetRunId === runId);
  const findings = Object.values(round?.reports || {}).reduce(
    (n, r) => n + (r.findings?.length || 0),
    0,
  );
  const working = Object.values(team.members).some((id) =>
    state.runs.some(
      (r) =>
        r.id === id &&
        ["queued", "preparing", "running"].includes(r.status) &&
        r.teamRole !== "developer",
    ),
  );
  if (
    quiet &&
    !findings &&
    !["failed", "stale"].includes(round?.status) &&
    !(team.enabled && (team.reason || team.roundsUsed >= team.maxRounds))
  )
    return null;
  const label = !team.enabled
    ? "Reviewers paused"
    : working
      ? "Reviewing…"
      : ["failed", "stale"].includes(round?.status)
        ? "Review needs attention"
        : findings
          ? `${findings} review findings`
          : round?.status === "completed"
            ? "Review available"
            : team.roundsUsed >= team.maxRounds
              ? "Review budget used"
              : team.reason
                ? "Review needs attention"
                : "Reviewers ready";
  return (
    <details className="team-badge">
      <summary>{label}</summary>
      <div className="team-popover">
        <p>
          Read-only teammates · {Math.max(0, team.maxRounds - team.roundsUsed)}{" "}
          rounds left
        </p>
        {team.reason && <p>{team.reason}</p>}
        {Object.entries(team.members)
          .filter(([role]) => role !== "developer")
          .map(([role, id]) => (
            <button key={id} onClick={() => goRun(id)}>
              {role}
              <span>
                {state.runs.find((r) => r.id === id)?.status || "Unavailable"}
              </span>
            </button>
          ))}
        <Button onClick={onSettings}>Team settings</Button>
      </div>
    </details>
  );
}

export function TeamReviews({ project, run, state, act, goRun, busy }) {
  const team = state.teams?.find((t) => t.projectId === project.id);
  const rounds = (state.teamRounds || []).filter(
    (r) => r.targetRunId === run.id || r.id === run.teamRoundId,
  );
  const [reason, setReason] = useState("");
  if (!team) return null;
  const isReviewer = run.teamRole && run.teamRole !== "developer";
  return (
    <section className="team-reviews">
      <div className="check-heading">
        <h3>Team reviews</h3>
        {!isReviewer &&
          team.enabled &&
          ["review", "accepted"].includes(run.status) && (
            <Button
              disabled={busy}
              onClick={() =>
                act(() =>
                  api(`/projects/${project.id}/team/review`, "POST", {
                    runId: run.id,
                  }),
                )
              }
            >
              Request current review
            </Button>
          )}
      </div>
      {!rounds.length && (
        <p className="muted-copy">
          {team.enabled
            ? "Reviewers wake after a completed implementation. They will report evidence here."
            : "Team watchers are paused."}
        </p>
      )}
      {rounds.map((round, i) => (
        <details className="team-round" key={round.id} open={i === 0}>
          <summary>
            {round.kind === "initial"
              ? "Project assessment"
              : round.kind === "memory"
                ? "Memory proposal"
                : "Change review"}{" "}
            · {round.status} · {round.snapshot.slice(0, 10)}
          </summary>
          <p className="muted-copy">
            Snapshot-bound model review, not a security certificate. Findings
            need your judgement.
          </p>
          {round.error && <p role="alert">{round.error}</p>}
          {round.roles.map((role) => {
            const report = round.reports[role];
            return (
              <article className="team-report" key={role}>
                <div className="team-report-head">
                  <h4>{role}</h4>
                  <button
                    onClick={() =>
                      goRun(round.members?.[role] || team.members[role])
                    }
                  >
                    Open agent session
                  </button>
                </div>
                {!report ? (
                  <p>Waiting for assessment…</p>
                ) : report.status === "failed" ? (
                  <p role="alert">{report.error}</p>
                ) : (
                  <>
                    <MD>{report.summary}</MD>
                    <p className="muted-copy">Coverage: {report.coverage}</p>
                    {report.findings.map((finding, index) => (
                      <div className="team-finding" key={index}>
                        <strong>{finding.title}</strong>
                        <small>
                          {finding.severity} severity · {finding.confidence}{" "}
                          confidence · {finding.file}
                          {finding.line ? `:${finding.line}` : ""}
                        </small>
                        <MD>{finding.evidence}</MD>
                        <p>Verify: {finding.verification}</p>
                      </div>
                    ))}
                    {!report.findings.length && (
                      <p className="muted-copy">
                        No findings reported within this assessment’s coverage.
                      </p>
                    )}
                    {report.memory && (
                      <details>
                        <summary>Proposed project notes</summary>
                        <MD>{report.memory}</MD>
                      </details>
                    )}
                  </>
                )}
              </article>
            );
          })}
          {round.proposal && (
            <p className="muted-copy">
              Saved as {round.proposal} in Project brain. Excluded from task
              context until human approval.
            </p>
          )}
          {round.acknowledgement && (
            <p>Findings acknowledged: {round.acknowledgement.reason}</p>
          )}
          {i === 0 &&
            round.status === "completed" &&
            !isReviewer &&
            run.status === "review" &&
            Object.values(round.reports).some((r) => r.findings?.length) && (
              <div className="team-actions">
                <Button
                  disabled={busy || run.sandbox !== "workspace-write"}
                  onClick={() =>
                    act(() =>
                      api(`/projects/${project.id}/team/fix`, "POST", {
                        roundId: round.id,
                      }),
                    )
                  }
                >
                  Send findings for a fix
                </Button>
                {!round.acknowledgement && (
                  <>
                    <input
                      aria-label="Reason for acknowledging team findings"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Explain what you checked or accepted…"
                    />
                    <Button
                      disabled={busy || reason.trim().length < 5}
                      onClick={() =>
                        act(() =>
                          api(
                            `/projects/${project.id}/team/acknowledge`,
                            "POST",
                            { roundId: round.id, reason },
                          ),
                        )
                      }
                    >
                      Acknowledge findings
                    </Button>
                  </>
                )}
              </div>
            )}
        </details>
      ))}
    </section>
  );
}
