export type WidgetResource = {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  _meta: Record<string, unknown>;
};

const RESOURCE_CSP = {
  connectDomains: [],
  resourceDomains: [],
  frameDomains: []
};

const widgetDefinitions: Array<
  Pick<WidgetResource, 'uri' | 'name' | 'description'> & { title: string }
> = [
  {
    uri: 'ui://overlord/mission-list.html',
    name: 'Overlord mission list',
    description: 'Renders a bounded list of missions returned by Overlord search.',
    title: 'Missions'
  },
  {
    uri: 'ui://overlord/objective-viewer.html',
    name: 'Overlord objective viewer',
    description: 'Renders structured context and objectives for one Overlord mission.',
    title: 'Mission context'
  },
  {
    uri: 'ui://overlord/file-changes.html',
    name: 'Overlord file-change viewer',
    description: 'Renders delivery details and recorded file-change rationales.',
    title: 'Delivery details'
  },
  {
    uri: 'ui://overlord/project-selector.html',
    name: 'Overlord project selector',
    description: 'Renders resolved project identity so a user can verify the selected project.',
    title: 'Project'
  }
];

function escapeForScript(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script').replace(/</g, '\\u003c');
}

function widgetHtml(title: string): string {
  const safeTitle = escapeForScript(title);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0; padding: 12px; color: CanvasText; background: Canvas; }
  h1 { font-size: 15px; margin: 0 0 8px; } p { margin: 0 0 10px; color: color-mix(in srgb, CanvasText 70%, Canvas); font-size: 13px; }
  .item { border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); border-radius: 8px; margin: 6px 0; padding: 8px; }
  .label { font-size: 11px; color: color-mix(in srgb, CanvasText 65%, Canvas); text-transform: uppercase; letter-spacing: .04em; }
  .value { font-size: 13px; margin-top: 2px; overflow-wrap: anywhere; } pre { margin: 0; white-space: pre-wrap; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
</style></head><body>
<h1>${safeTitle}</h1><p id="status">Waiting for Overlord data…</p><section id="content"></section>
<script>
  const content = document.getElementById('content'); const status = document.getElementById('status');
  function add(label, value) { const item = document.createElement('div'); item.className = 'item'; const key = document.createElement('div'); key.className = 'label'; key.textContent = label; const body = document.createElement('div'); body.className = 'value'; body.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); item.append(key, body); content.append(item); }
  function render(data) { content.replaceChildren(); status.textContent = 'Overlord result'; if (!data || typeof data !== 'object') { add('Result', data); return; }
    const entries = Array.isArray(data) ? data : Object.entries(data); for (const entry of entries) { if (Array.isArray(entry) && entry.length === 2) add(entry[0], entry[1]); else add('Result', entry); }
  }
  window.addEventListener('message', event => { if (event.source !== window.parent) return; const message = event.data; if (!message || message.jsonrpc !== '2.0' || message.method !== 'ui/notifications/tool-result') return; render(message.params && message.params.structuredContent); }, { passive: true });
  if (window.openai && window.openai.toolOutput) render(window.openai.toolOutput);
</script></body></html>`;
}

export const hostedMcpWidgetResources: WidgetResource[] = widgetDefinitions.map(widget => ({
  uri: widget.uri,
  name: widget.name,
  description: widget.description,
  mimeType: 'text/html;profile=mcp-app',
  _meta: { ui: { csp: RESOURCE_CSP, prefersBorder: true } }
}));

export function readHostedMcpWidget(uri: string): (WidgetResource & { text: string }) | null {
  const widget = widgetDefinitions.find(candidate => candidate.uri === uri);
  if (!widget) return null;
  const resource = hostedMcpWidgetResources.find(candidate => candidate.uri === uri);
  if (!resource) return null;
  return { ...resource, text: widgetHtml(widget.title) };
}
