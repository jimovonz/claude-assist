import { randomBytes } from "crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const VIEWS_DIR = join(import.meta.dir, "..", "..", "views");
const VIEWS_INDEX = join(VIEWS_DIR, "index.json");

// Ensure views directory exists
try { mkdirSync(VIEWS_DIR, { recursive: true }); } catch {}

// Edge server URL for remote view hosting
const EDGE_URL = process.env.EDGE_URL ?? "";
const EDGE_API_SECRET = process.env.EDGE_API_SECRET ?? "";

export interface ViewOptions {
  title?: string;
  content: string;
  ttlMs?: number;
  channel?: string;
  userId?: string;
  channelId?: string; // session to route actions back to
}

export interface ViewRecord {
  slug: string;
  title: string;
  url: string;
  localUrl: string;
  createdAt: string;
  channel?: string;
  userId?: string;
  channelId?: string;
  chars: number;
}

/**
 * Generate a descriptive slug from title/content for readable URLs.
 */
function generateSlug(title: string, content: string): string {
  // Use title if meaningful, otherwise extract from first heading or sentence
  let base = title !== "Claude Response" ? title : "";
  if (!base) {
    const headingMatch = content.match(/^#{1,3}\s+(.+)$/m);
    if (headingMatch) {
      base = headingMatch[1];
    } else {
      base = content.split("\n")[0].substring(0, 60);
    }
  }

  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);

  const suffix = randomBytes(3).toString("hex");
  return slug ? `${slug}-${suffix}` : suffix;
}

/**
 * Load the views index from disk.
 */
export function loadViewIndex(): ViewRecord[] {
  try {
    if (existsSync(VIEWS_INDEX)) {
      return JSON.parse(readFileSync(VIEWS_INDEX, "utf-8"));
    }
  } catch {}
  return [];
}

/**
 * Save a view record to the index.
 */
function saveViewRecord(record: ViewRecord): void {
  const index = loadViewIndex();
  index.unshift(record); // newest first
  // Keep last 100 entries
  if (index.length > 100) index.length = 100;
  writeFileSync(VIEWS_INDEX, JSON.stringify(index, null, 2));
}

/**
 * Render markdown-like content to HTML with syntax highlighting support.
 */
export function renderContent(content: string): string {
  // Escape ALL content first to prevent XSS, then selectively
  // re-introduce safe HTML structure via markdown transformations.
  let html = escapeHtml(content);

  // Convert code blocks with language tags (already escaped, keep as-is)
  html = html.replace(
    /```(\w+)?\n([\s\S]*?)```/g,
    (_, lang, code) => {
      const langClass = lang ? ` class="language-${lang}"` : "";
      return `<pre><code${langClass}>${code.trim()}</code></pre>`;
    }
  );

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Links [text](url) — unescape &amp; back to & in href for valid URLs
  // Reject javascript: and data: URLs to prevent XSS
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const cleanUrl = url.replace(/&amp;/g, '&');
    if (/^\s*(javascript|data|vbscript):/i.test(cleanUrl)) {
      return text; // Strip the link, keep the text
    }
    return `<a href="${cleanUrl}">${text}</a>`;
  });

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Headers
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // List items
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // Paragraphs — wrap remaining loose text
  html = html.replace(/\n\n/g, "</p><p>");
  html = `<p>${html}</p>`;

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, "");
  html = html.replace(/<p>\s*(<h[1-3]>)/g, "$1");
  html = html.replace(/(<\/h[1-3]>)\s*<\/p>/g, "$1");
  html = html.replace(/<p>\s*(<pre>)/g, "$1");
  html = html.replace(/(<\/pre>)\s*<\/p>/g, "$1");
  html = html.replace(/<p>\s*(<ul>)/g, "$1");
  html = html.replace(/(<\/ul>)\s*<\/p>/g, "$1");

  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Generate a full HTML page for a view.
 */
function generateHtml(title: string, content: string, options?: { actions?: ViewAction[]; viewId?: string }): string {
  const rendered = renderContent(content);
  const actions = options?.actions ?? [];
  const viewId = options?.viewId ?? "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root {
      --bg: #1a1b26;
      --fg: #c0caf5;
      --accent: #7aa2f7;
      --border: #3b4261;
      --code-bg: #24283b;
      --success: #9ece6a;
      --error: #f7768e;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
      padding: 16px;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
    }

    h1 { font-size: 1.4em; color: var(--accent); margin-bottom: 16px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    h2 { font-size: 1.2em; color: var(--accent); margin: 16px 0 8px; }
    h3 { font-size: 1.1em; color: var(--fg); margin: 12px 0 6px; }

    p { margin: 8px 0; }

    pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      overflow-x: auto;
      margin: 12px 0;
      font-size: 13px;
      line-height: 1.5;
    }

    code {
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 0.9em;
    }

    :not(pre) > code {
      background: var(--code-bg);
      padding: 2px 6px;
      border-radius: 3px;
    }

    ul { padding-left: 20px; margin: 8px 0; }
    li { margin: 4px 0; }

    strong { color: #e0af68; }

    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .diff-add { color: var(--success); }
    .diff-del { color: var(--error); }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 20px 0;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--code-bg);
    }

    .action-btn {
      padding: 8px 16px;
      border: 1px solid var(--accent);
      border-radius: 6px;
      background: transparent;
      color: var(--accent);
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .action-btn:hover {
      background: var(--accent);
      color: var(--bg);
    }

    .action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .action-btn.done {
      border-color: var(--success);
      color: var(--success);
    }

    .action-status {
      font-size: 13px;
      color: #565f89;
      margin-top: 8px;
      display: none;
    }

    .meta {
      font-size: 0.8em;
      color: #565f89;
      margin-top: 24px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${rendered}
  ${actions.length > 0 ? `
  <div class="actions" id="action-bar">
    ${actions.map(a => `<button class="action-btn" data-action-id="${escapeHtml(a.id)}" onclick="doAction(this)">${escapeHtml(a.label)}</button>`).join("\n    ")}
    <div class="action-status" id="action-status"></div>
  </div>` : ""}
  <div class="meta">Generated by claude-assist / Conduit</div>
  <script>
    // Telegram Mini App integration
    if (window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.ready();
      tg.expand();

      // Match Telegram theme
      document.body.style.background = tg.themeParams.bg_color || '#1a1b26';
      document.body.style.color = tg.themeParams.text_color || '#c0caf5';
    }

    async function doAction(btn) {
      const actionId = btn.dataset.actionId;
      const label = btn.textContent;
      const viewId = ${JSON.stringify(viewId)};
      const status = document.getElementById('action-status');

      // Disable all buttons
      document.querySelectorAll('.action-btn').forEach(b => b.disabled = true);
      btn.textContent = label + '...';
      status.style.display = 'block';
      status.textContent = 'Sending...';

      try {
        const res = await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ viewId, actionId, label }),
        });
        const data = await res.json();
        btn.classList.add('done');
        btn.textContent = label + ' ✓';
        status.textContent = data.message || 'Action sent';
      } catch (err) {
        btn.textContent = label;
        status.textContent = 'Failed: ' + err.message;
        document.querySelectorAll('.action-btn').forEach(b => b.disabled = false);
      }
    }
  </script>
</body>
</html>`;
}

/**
 * Create a view. If EDGE_URL is configured, pushes to edge and returns the
 * edge URL directly. Otherwise writes locally and returns a local token.
 */
export async function createViewAsync(options: ViewOptions): Promise<{ token: string; url?: string }> {
  const title = options.title ?? "Claude Response";
  const { content: cleanContent, actions } = extractActions(options.content);
  const slug = generateSlug(title, cleanContent);
  const html = generateHtml(title, cleanContent, { actions, viewId: slug });

  // Always write locally as fallback
  writeFileSync(join(VIEWS_DIR, `${slug}.html`), html);
  console.log(`[views] Created view ${slug} (${html.length} bytes)`);

  let viewUrl = "";

  // Push to edge if configured
  if (EDGE_URL) {
    try {
      const edgeId = await pushViewToEdge(html, slug);
      if (edgeId) {
        viewUrl = `${EDGE_URL}/view/${edgeId}`;
        saveViewRecord({
          slug, title, url: viewUrl,
          localUrl: `/view/${slug}`,
          createdAt: new Date().toISOString(),
          channel: options.channel, userId: options.userId,
          channelId: options.channelId,
          chars: options.content.length,
        });
        return { token: slug, url: viewUrl };
      }
    } catch (err: any) {
      console.error(`[views] Failed to push to edge: ${err.message}`);
    }
  }

  saveViewRecord({
    slug, title, url: `/view/${slug}`,
    localUrl: `/view/${slug}`,
    createdAt: new Date().toISOString(),
    channel: options.channel, userId: options.userId,
    channelId: options.channelId,
    chars: options.content.length,
  });

  return { token: slug };
}

/**
 * Synchronous createView for backwards compatibility.
 */
export function createView(options: ViewOptions): string {
  const title = options.title ?? "Claude Response";
  const { content: cleanContent, actions } = extractActions(options.content);
  const slug = generateSlug(title, cleanContent);
  const html = generateHtml(title, cleanContent, { actions, viewId: slug });
  writeFileSync(join(VIEWS_DIR, `${slug}.html`), html);
  console.log(`[views] Created view ${slug} (${html.length} bytes)`);

  saveViewRecord({
    slug, title, url: `/view/${slug}`,
    localUrl: `/view/${slug}`,
    createdAt: new Date().toISOString(),
    channel: options.channel, userId: options.userId,
    channelId: options.channelId,
    chars: options.content.length,
  });

  return slug;
}

async function pushViewToEdge(html: string, slug?: string): Promise<string | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (EDGE_API_SECRET) headers["Authorization"] = `Bearer ${EDGE_API_SECRET}`;

  const body: Record<string, string> = { content: html };
  if (slug) body.id = slug;

  const res = await fetch(`${EDGE_URL}/api/views`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`[views] Edge rejected view: ${res.status}`);
    return null;
  }
  const data = await res.json() as { id: string };
  console.log(`[views] Pushed to edge: ${data.id}`);
  return data.id;
}

export { EDGE_URL };

// --- Action tags ---

export interface ViewAction {
  id: string;
  label: string;
}

/**
 * Extract <action> tags from content.
 * Returns the cleaned content (tags removed) and the list of actions.
 */
export function extractActions(content: string): { content: string; actions: ViewAction[] } {
  const actions: ViewAction[] = [];
  const cleaned = content.replace(/<action\s+id="([^"]+)"(?:\s+[^>]*)?>([^<]+)<\/action>/gi, (_, id, label) => {
    actions.push({ id: id.trim(), label: label.trim() });
    return "";
  });
  return { content: cleaned.trim(), actions };
}

/**
 * Check if a response should be rendered as a rich view.
 * Returns true for long responses, code-heavy content, or diffs.
 */
export function shouldCreateView(text: string): boolean {
  if (text.length > 500) return true;
  if ((text.match(/```/g) ?? []).length >= 2) return true;
  if (text.includes("diff\n") || text.includes("+++ ") || text.includes("--- ")) return true;
  return false;
}
