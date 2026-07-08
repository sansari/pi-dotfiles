// Global "browser" extension for pi.
// Gives the agent two tools, with no external dependencies:
//   - web_search: search the web (DuckDuckGo HTML endpoint, no API key)
//   - web_fetch:  fetch a URL and return readable markdown/text (or raw HTML)
//
// Lives in ~/.pi/agent/extensions/ so it loads for every `pi` run, all projects.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const DEFAULT_MAX_CHARS = 50_000;

async function httpGet(
  url: string,
  signal: AbortSignal | undefined,
  init?: RequestInit,
): Promise<{ status: number; finalUrl: string; body: string; contentType: string }> {
  const res = await fetch(url, {
    redirect: "follow",
    signal,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  const body = await res.text();
  return {
    status: res.status,
    finalUrl: res.url || url,
    body,
    contentType: res.headers.get("content-type") ?? "",
  };
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// Best-effort HTML -> readable text/markdown. Dependency-free.
function htmlToText(html: string, asMarkdown: boolean): string {
  let s = html;
  // Drop non-content regions.
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|svg|head|nav|footer|form|iframe)\b[\s\S]*?<\/\1>/gi, " ");
  // Extract main/article if present to reduce chrome.
  const main = s.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
  if (main) s = main[1];

  if (asMarkdown) {
    s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, t) => `\n\n${"#".repeat(Number(lvl))} ${strip(t)}\n\n`);
    s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `\n- ${strip(t)}`);
    s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => {
      const label = strip(t);
      if (!label) return "";
      return `[${label}](${href})`;
    });
    s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _g, t) => `**${strip(t)}**`);
    s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _g, t) => `*${strip(t)}*`);
    s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, t) => `\`${strip(t)}\``);
    s = s.replace(/<(p|div|section|tr|br|h[1-6])\b[^>]*>/gi, "\n");
  }

  s = s.replace(/<[^>]+>/g, " ");
  s = decode(s);
  s = s.replace(/[ \t\f\v]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/^[ \t]+| [ \t]+$/gm, "").trim();
  return s;
}

function strip(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function clamp(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + `\n\n…[truncated ${text.length - max} chars]`, truncated: true };
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDuckDuckGo(html: string, count: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const a = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    let url = decode(a[1]);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    const title = strip(a[2]);
    const snipMatch = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = snipMatch ? strip(snipMatch[1]) : "";
    if (title && url) results.push({ title, url, snippet });
    if (results.length >= count) break;
  }
  return results;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web and return a ranked list of results (title, URL, snippet). " +
      "Use this to find pages, then call web_fetch to read one.",
    promptSnippet: "Search the web for current information",
    promptGuidelines: [
      "Use web_search to find current/online information, then web_fetch to read promising results.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      count: Type.Optional(Type.Integer({ description: "Max results (default 8)", minimum: 1, maximum: 20 })),
    }),
    async execute(_id, params, signal) {
      const count = params.count ?? 8;
      const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(params.query)}`;
      const { status, body } = await httpGet(endpoint, signal);
      if (status >= 400) {
        return { content: [{ type: "text", text: `Search failed: HTTP ${status}` }], isError: true, details: {} };
      }
      const results = parseDuckDuckGo(body, count);
      if (results.length === 0) {
        return { content: [{ type: "text", text: `No results for "${params.query}".` }], details: { results } };
      }
      const text = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
        .join("\n\n");
      return { content: [{ type: "text", text }], details: { results } };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and return its content. Default format 'markdown' returns readable text. " +
      "Use 'html' for raw HTML, 'text' for plain text.",
    promptSnippet: "Fetch and read a web page by URL",
    promptGuidelines: ["Use web_fetch to read a web page or API response by URL."],
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL (http/https)" }),
      format: Type.Optional(StringEnum(["markdown", "text", "html"] as const)),
      maxChars: Type.Optional(Type.Integer({ description: `Max characters (default ${DEFAULT_MAX_CHARS})`, minimum: 500 })),
    }),
    async execute(_id, params, signal) {
      let url = params.url.trim();
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      const format = params.format ?? "markdown";
      const max = params.maxChars ?? DEFAULT_MAX_CHARS;
      let res;
      try {
        res = await httpGet(url, signal);
      } catch (e) {
        return { content: [{ type: "text", text: `Fetch failed: ${(e as Error).message}` }], isError: true, details: {} };
      }
      const isHtml = res.contentType.includes("html") || /^\s*</.test(res.body);
      let out: string;
      if (format === "html" || !isHtml) {
        out = res.body;
      } else {
        out = htmlToText(res.body, format === "markdown");
      }
      const { text, truncated } = clamp(out, max);
      const header = `# ${res.finalUrl}\n(HTTP ${res.status}${res.finalUrl !== url ? `, redirected from ${url}` : ""})\n\n`;
      return {
        content: [{ type: "text", text: header + text }],
        details: { status: res.status, finalUrl: res.finalUrl, contentType: res.contentType, truncated },
      };
    },
  });
}
