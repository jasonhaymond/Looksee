// Decides whether the endpoint page warns about how the agent is running, and in what
// words. The agent reports this on each report (agent/internal/metrics/runmode.go);
// the engine stores it with the rest of the report. Kept apart from the page so the
// engine's test runner can check every case (engine/test/agent-run.test.ts).

/** How the agent says it's running. Older agents don't report this. */
export type AgentRun = { service: boolean; elevated: boolean };

/**
 * The warning to show for an endpoint's agent.
 * @param run what the agent reported; missing for agents older than 5.5
 * @param os the endpoint's operating system, since only Windows loses readings
 *   without administrator rights (Linux agents run unprivileged on purpose)
 * @returns the message, or null when the agent is fine or hasn't said, so an older
 *   agent never gets a warning it did nothing to earn
 */
export function agentRunNotice(run: AgentRun | null | undefined, os: string | null | undefined): string | null {
  if (!run || run.service) return null;
  const stops = "This agent isn't running as a service, so it stops when the window or session that started it closes.";
  const fix = "Install it from the Agent tab to fix this.";
  if (/windows/i.test(os ?? "") && !run.elevated) {
    return `${stops} It also has no administrator rights, so some readings are missing or wrong, such as disk encryption, failed logins and the memory of protected processes. ${fix}`;
  }
  return `${stops} ${fix}`;
}
