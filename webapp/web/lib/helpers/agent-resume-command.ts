/**
 * Build the shell command that reopens an agent's *native* session so a user
 * can chat with the agent about what happened in an objective.
 *
 * This is deliberately Overlord-free: it neither queues an execution request nor
 * opens a protocol session — it simply resumes the agent's own conversation
 * thread (identified by `objectives.external_session_id`) in a terminal. Because
 * nothing touches the mission queue, it is safe to reopen even while another
 * objective on the same mission is executing.
 *
 * Returns `null` when the objective never recorded a native session id or the
 * agent has no resume syntax we can assert, so callers can hide the affordance
 * rather than copy a command that would not work. Add agents here only once
 * their native resume invocation is confirmed.
 *
 * Binaries mirror the launch-time mapping in `cli/src/agent-binaries.ts`
 * (notably cursor is invoked as `agent`) so the copied command matches how
 * Overlord itself launches each agent.
 */
const AGENT_RESUME_COMMAND: Record<string, (sessionId: string) => string> = {
  claude: sessionId => `claude --resume ${sessionId}`,
  codex: sessionId => `codex resume ${sessionId}`,
  cursor: sessionId => `agent --resume=${sessionId}`,
  pi: sessionId => `pi --session ${sessionId}`
};

export function buildAgentResumeCommand({
  agent,
  sessionId
}: {
  agent: string | null | undefined;
  sessionId: string | null | undefined;
}): string | null {
  const key = agent?.trim().toLowerCase();
  const id = sessionId?.trim();
  if (!key || !id) return null;
  const builder = AGENT_RESUME_COMMAND[key];
  return builder ? builder(id) : null;
}
