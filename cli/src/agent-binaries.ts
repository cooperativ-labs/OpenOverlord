/** Native agent binary names by connector key, for PATH detection and launch. */
const AGENT_BINARIES: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'agent'
};

/** Map a connector agent key to the executable invoked at launch time. */
export function resolveAgentBinary(agentKey: string): string {
  return AGENT_BINARIES[agentKey] ?? agentKey;
}
