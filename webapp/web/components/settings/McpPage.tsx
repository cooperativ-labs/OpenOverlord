import type { ReactNode } from 'react';
import {
  Bot,
  Cable,
  Check,
  Cloud,
  CloudOff,
  Copy,
  ExternalLink,
  KeyRound,
  Sparkles
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCopyToClipboard } from '@/lib/hooks/use-copy-to-clipboard';
import { getApiBaseUrl, getAuthBaseUrl, isRemoteBackend } from '@/lib/api-base.ts';
import { useMeta } from '@/lib/queries';

function isHostedMcpBackend({
  backendMode,
  clientUsesRemoteBackend
}: {
  backendMode: 'local' | 'cloud' | undefined;
  clientUsesRemoteBackend: boolean;
}): boolean {
  return backendMode === 'cloud' || clientUsesRemoteBackend;
}

const MCP_TOOLS = [
  { name: 'overlord_resolve_project', label: 'Resolve project' },
  { name: 'overlord_search_missions', label: 'Search missions' },
  { name: 'overlord_create_mission', label: 'Create mission' },
  { name: 'overlord_load_mission_context', label: 'Load mission context' },
  { name: 'overlord_add_objectives', label: 'Add objectives' },
  { name: 'overlord_attach_session', label: 'Attach session' },
  { name: 'overlord_update_session', label: 'Update session' },
  { name: 'overlord_deliver_session', label: 'Deliver session' }
] as const;

type McpPageProps = {
  onNavigateToBackend?: () => void;
  onNavigateToTokens?: () => void;
};

function resolveMcpBaseUrl(): string {
  const apiBase = getApiBaseUrl().trim();
  if (apiBase) return apiBase.replace(/\/+$/, '');
  return getAuthBaseUrl().replace(/\/+$/, '');
}

function CopyValueRow({ label, value, description }: { label: string; value: string; description?: string }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{label}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2 text-xs"
          onClick={() => void copy(value)}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <code className="block truncate rounded-md border bg-muted/60 px-3 py-2 font-mono text-xs">
        {value}
      </code>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  );
}

function ProviderSetupCard({
  title,
  accentClassName,
  children
}: {
  title: string;
  accentClassName: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className={`border-b px-4 py-3 ${accentClassName}`}>
        <div className="flex items-center gap-2">
          <Bot className="size-4" />
          <h3 className="text-sm font-medium">{title}</h3>
        </div>
      </div>
      <ol className="list-decimal space-y-2 px-4 py-4 pl-8 text-sm text-muted-foreground">{children}</ol>
    </div>
  );
}

function LocalModeDisclaimer({
  onNavigateToBackend,
  isDesktop
}: {
  onNavigateToBackend?: () => void;
  isDesktop: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-dashed border-muted-foreground/30 bg-gradient-to-br from-muted/40 via-background to-muted/20">
      <div className="flex flex-col gap-6 p-6 sm:p-8">
        <div className="flex items-start gap-4">
          <div className="rounded-2xl border bg-background/80 p-3 shadow-sm">
            <CloudOff className="size-6 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold tracking-tight">Cloud backend required</h3>
              <Badge variant="outline">Local mode</Badge>
            </div>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Hosted MCP lets cloud agents such as ChatGPT and Claude connect to your Overlord
              workspace over the internet. That endpoint runs on your hosted Postgres backend, not
              on a local SQLite database.
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {[
            {
              title: 'What MCP unlocks',
              body: 'Agents can search missions, attach to objectives, post progress, and deliver work without a local checkout.'
            },
            {
              title: 'Why local mode blocks it',
              body: 'Your app is pointed at a machine-local database that remote agents cannot reach.'
            },
            {
              title: 'How to enable it',
              body: isDesktop
                ? 'Switch to a cloud backend profile, then return here for connector URLs.'
                : 'Point the CLI and web app at your hosted backend with `ovld config set cloud <url>`.'
            }
          ].map(card => (
            <div key={card.title} className="rounded-xl border bg-background/70 p-4">
              <p className="text-sm font-medium">{card.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{card.body}</p>
            </div>
          ))}
        </div>

        {isDesktop && onNavigateToBackend ? (
          <div>
            <Button type="button" onClick={onNavigateToBackend}>
              <Cloud className="size-4" />
              Open backend settings
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function McpPage({ onNavigateToBackend, onNavigateToTokens }: McpPageProps) {
  const meta = useMeta();
  const isDesktop = typeof window !== 'undefined' && window.overlord?.isDesktop === true;
  const isCloudBackend = isHostedMcpBackend({
    backendMode: meta.data?.backendMode,
    clientUsesRemoteBackend: isRemoteBackend()
  });
  const mcpEnabled = meta.data?.capabilities.mcp === true;
  const baseUrl = resolveMcpBaseUrl();
  const mcpUrl = `${baseUrl}/mcp`;
  const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource/mcp`;
  const authServerMetadataUrl = `${baseUrl}/.well-known/oauth-authorization-server`;

  if (meta.isLoading && !meta.data) {
    return <p className="text-sm text-muted-foreground">Loading MCP settings…</p>;
  }

  if (!isCloudBackend) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Cable className="size-5 text-primary" />
            <h2 className="text-base font-medium">MCP</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Connect cloud agents to your Overlord workspace through the hosted Model Context
            Protocol endpoint.
          </p>
        </div>
        <LocalModeDisclaimer onNavigateToBackend={onNavigateToBackend} isDesktop={isDesktop} />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Cable className="size-5 text-primary" />
          <h2 className="text-base font-medium">MCP</h2>
          <Badge className="bg-primary/10 text-primary hover:bg-primary/10">Cloud</Badge>
          {mcpEnabled ? (
            <Badge variant="secondary" className="gap-1">
              <Sparkles className="size-3" />
              Enabled
            </Badge>
          ) : (
            <Badge variant="outline">Not enabled on this backend</Badge>
          )}
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Give ChatGPT, Claude, and other MCP clients a secure bridge to your workspace. Add the
          server URL in your agent product, authenticate with Overlord, and the agent can work
          missions through the tool catalog below.
        </p>
      </div>

      {!mcpEnabled ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
          This cloud backend has not turned on hosted MCP yet. Ask your administrator to set{' '}
          <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-xs">
            OVERLORD_MCP_ENABLED=true
          </code>{' '}
          on the backend deployment. The connection details below are still the values you will
          use once it is live.
        </div>
      ) : null}

      <div className="space-y-4 rounded-2xl border bg-card p-5 shadow-sm">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Connection details</h3>
          <p className="text-xs text-muted-foreground">
            Paste these into your agent product&apos;s custom MCP connector settings.
          </p>
        </div>
        <div className="space-y-4">
          <CopyValueRow
            label="MCP server URL"
            value={mcpUrl}
            description="Primary endpoint for remote MCP clients."
          />
          <CopyValueRow
            label="OAuth resource metadata"
            value={resourceMetadataUrl}
            description="Protected-resource metadata advertised to OAuth-aware MCP clients."
          />
          <CopyValueRow
            label="Authorization server metadata"
            value={authServerMetadataUrl}
            description="OAuth authorization-server discovery document for sign-in flows."
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ProviderSetupCard title="ChatGPT custom connector" accentClassName="bg-emerald-500/10">
          <li>Open ChatGPT settings and add a custom MCP connector.</li>
          <li>Paste the MCP server URL above.</li>
          <li>
            Complete the Overlord sign-in when prompted. OAuth consent UI is rolling out; until
            then, use a mission-lifecycle token from Tokens if your client supports bearer auth.
          </li>
          <li>Ask the agent to list tools and search your missions.</li>
        </ProviderSetupCard>

        <ProviderSetupCard title="Claude custom connector" accentClassName="bg-orange-500/10">
          <li>
            In Claude Team or Enterprise, an admin adds a custom remote MCP connector with the
            server URL above.
          </li>
          <li>Each teammate connects individually and signs in to Overlord.</li>
          <li>
            Grant workspace access during consent so the agent can only see missions you already
            have permission to read.
          </li>
          <li>Start a chat and ask Claude to attach to a mission or create a new one.</li>
        </ProviderSetupCard>
      </div>

      <div className="rounded-2xl border bg-muted/20 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <KeyRound className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Bearer token fallback</h3>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Until interactive OAuth is fully live, create a token with the{' '}
              <strong className="font-medium text-foreground">Mission lifecycle + runner</strong>{' '}
              scope and configure your MCP client to send{' '}
              <code className="rounded bg-background px-1 py-0.5 font-mono text-xs">
                Authorization: Bearer &lt;token&gt;
              </code>
              . Include your active workspace with{' '}
              <code className="rounded bg-background px-1 py-0.5 font-mono text-xs">
                X-Overlord-Active-Workspace
              </code>{' '}
              when the client allows custom headers.
            </p>
          </div>
          {onNavigateToTokens ? (
            <Button type="button" variant="outline" size="sm" onClick={onNavigateToTokens}>
              Open tokens
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">Available tools</h3>
            <p className="text-xs text-muted-foreground">
              Mission-first catalog exposed by the hosted MCP server.
            </p>
          </div>
          <a
            href="https://modelcontextprotocol.io"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            MCP spec
            <ExternalLink className="size-3" />
          </a>
        </div>
        <div className="flex flex-wrap gap-2">
          {MCP_TOOLS.map(tool => (
            <div
              key={tool.name}
              className="rounded-full border bg-background px-3 py-1.5 text-xs"
              title={tool.name}
            >
              <span className="font-medium">{tool.label}</span>
              <span className="ml-2 font-mono text-[10px] text-muted-foreground">{tool.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
