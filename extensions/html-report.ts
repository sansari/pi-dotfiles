// Global "HTML report" extension for pi.
// Makes "turn markdown into a browsable HTML report" available in every session.
//   - tool  `html_report`  : LLM-callable; render inline markdown, file(s), or a
//                            directory of *.md into one styled, navigable .html
//   - command `/report`    : user shortcut to render the cwd's *.md into report.html
//
// No external dependencies. Lives in ~/.pi/agent/extensions/ so it always loads.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { spawn } from "node:child_process";

// ---------- markdown -> html ----------
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s: string): string {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    const safe = String(href).replace(/"/g, "%22");
    const ext = /^https?:/.test(href) ? ' target="_blank" rel="noopener"' : "";
    return `<a href="${safe}"${ext}>${label}</a>`;
  });
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, (_m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  return t;
}

function mdToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  const listStack: string[] = [];
  const closeList = () => { while (listStack.length) out.push(listStack.pop() as string); };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(esc(lines[i])); i++; }
      i++;
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeList();
      const parseRow = (r: string) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const headers = parseRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(parseRow(lines[i])); i++; }
      let tbl = "<table><thead><tr>" + headers.map((h) => `<th>${inline(h)}</th>`).join("") + "</tr></thead><tbody>";
      for (const r of rows) tbl += "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
      tbl += "</tbody></table>";
      out.push(tbl);
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = h[1].length;
      const id = h[2].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      out.push(`<h${lvl} id="${id}">${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      closeList();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      out.push(`<blockquote>${mdToHtml(buf.join("\n"))}</blockquote>`);
      continue;
    }

    const li = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (li) {
      const depth = Math.floor(li[1].length / 2);
      while (listStack.length > depth + 1) out.push(listStack.pop() as string);
      if (listStack.length < depth + 1) { out.push("<ul>"); listStack.push("</ul>"); }
      let item = li[2];
      let prefix = "";
      if (/^\[ \]\s+/.test(item)) { prefix = '<span class="cb">\u2610</span> '; item = item.replace(/^\[ \]\s+/, ""); }
      else if (/^\[x\]\s+/i.test(item)) { prefix = '<span class="cb done">\u2611</span> '; item = item.replace(/^\[x\]\s+/i, ""); }
      else if (/^\[~\]\s+/.test(item)) { prefix = '<span class="cb wip">\u25d0</span> '; item = item.replace(/^\[~\]\s+/, ""); }
      else if (/^\[\?\]\s+/.test(item)) { prefix = '<span class="cb q">?</span> '; item = item.replace(/^\[\?\]\s+/, ""); }
      out.push(`<li>${prefix}${inline(item)}</li>`);
      i++;
      continue;
    }

    if (/^---+\s*$/.test(line)) { closeList(); out.push("<hr>"); i++; continue; }
    if (/^\s*$/.test(line)) { closeList(); i++; continue; }

    closeList();
    const buf = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|\s*>|\s*[-*]\s|---+\s*$|\s*\|)/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  closeList();
  return out.join("\n");
}

interface Section { id: string; title: string; html: string; }

function renderDocument(title: string, sections: Section[]): string {
  const multi = sections.length > 1;
  const nav = multi
    ? `<nav><h2>${esc(title)}</h2>\n${sections.map((s) => `<a href="#${s.id}">${esc(s.title)}</a>`).join("\n")}</nav>`
    : "";
  const body = sections
    .map((s) => `<section id="${s.id}">${multi ? `<div class="doc-tag">${esc(s.title)}</div>` : ""}\n${s.html}</section>`)
    .join('\n<hr class="sep">\n');
  const generated = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--fg:#e6edf3;--muted:#8b949e;--accent:#58a6ff;--border:#30363d;--code:#1f2630;}
@media (prefers-color-scheme: light){:root{--bg:#fff;--panel:#f6f8fa;--fg:#1f2328;--muted:#636c76;--accent:#0969da;--border:#d0d7de;--code:#f0f3f6;}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);}
.layout{display:flex;align-items:flex-start;}
nav{position:sticky;top:0;height:100vh;overflow:auto;min-width:230px;max-width:230px;padding:24px 16px;border-right:1px solid var(--border);background:var(--panel);font-size:14px;}
nav h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 12px;}
nav a{display:block;color:var(--fg);text-decoration:none;padding:6px 10px;border-radius:6px;margin-bottom:2px;}
nav a:hover{background:rgba(127,127,127,.15);}
main{flex:1;max-width:900px;margin:0 auto;padding:32px 40px 120px;}
.gen{color:var(--muted);font-size:13px;margin-bottom:24px;}
.doc-tag{display:inline-block;font-size:12px;color:var(--muted);background:var(--code);border:1px solid var(--border);border-radius:999px;padding:2px 10px;margin-bottom:8px;}
h1{font-size:30px;margin:.4em 0 .3em;border-bottom:1px solid var(--border);padding-bottom:.2em;}
h2{font-size:23px;margin:1.4em 0 .3em;border-bottom:1px solid var(--border);padding-bottom:.2em;}
h3{font-size:18px;margin:1.2em 0 .3em;}
a{color:var(--accent);}
code{background:var(--code);padding:.15em .4em;border-radius:5px;font:13.5px ui-monospace,SFMono-Regular,Menlo,monospace;}
pre{background:var(--code);border:1px solid var(--border);border-radius:8px;padding:14px 16px;overflow:auto;}
pre code{background:none;padding:0;}
blockquote{border-left:3px solid var(--accent);margin:1em 0;padding:.2em 1em;color:var(--muted);background:rgba(127,127,127,.06);border-radius:0 8px 8px 0;}
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:14.5px;display:block;overflow:auto;}
th,td{border:1px solid var(--border);padding:7px 11px;text-align:left;vertical-align:top;}
th{background:var(--code);}
hr{border:none;border-top:1px solid var(--border);margin:1.4em 0;}
hr.sep{margin:3.5em 0;border-top:2px dashed var(--border);}
.cb{font-weight:700;color:var(--muted);} .cb.done{color:#3fb950;} .cb.wip{color:#d29922;} .cb.q{color:var(--accent);}
ul{padding-left:1.4em;} li{margin:.2em 0;}
section{scroll-margin-top:20px;}
</style></head>
<body><div class="layout">
${nav}
<main><div class="gen">Generated ${generated}</div>
${body}
</main></div></body></html>
`;
}

function openInBrowser(path: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [path], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.unref();
  } catch { /* ignore */ }
}

function gatherSections(cwd: string, opts: { markdown?: string; files?: string[]; dir?: string; title?: string }): Section[] {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "doc";
  const sections: Section[] = [];
  if (opts.dir) {
    const d = resolve(cwd, opts.dir);
    for (const f of readdirSync(d).filter((f) => f.toLowerCase().endsWith(".md")).sort()) {
      sections.push({ id: slug(f), title: f, html: mdToHtml(readFileSync(join(d, f), "utf8")) });
    }
  }
  for (const f of opts.files ?? []) {
    const p = resolve(cwd, f);
    sections.push({ id: slug(basename(f)), title: basename(f), html: mdToHtml(readFileSync(p, "utf8")) });
  }
  if (opts.markdown) {
    sections.push({ id: slug(opts.title ?? "report"), title: opts.title ?? "Report", html: mdToHtml(opts.markdown) });
  }
  return sections;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "html_report",
    label: "HTML Report",
    description:
      "Render markdown into a single styled, browsable HTML report (sidebar nav, " +
      "tables, code, task checkboxes, light/dark). Provide one of: `markdown` " +
      "(inline), `files` (list of .md paths), or `dir` (folder of .md). Writes the " +
      "file and (by default) opens it in the browser.",
    promptSnippet: "Generate a browsable HTML report from markdown",
    promptGuidelines: [
      "When the user asks for a report, or when you produce substantial research/summary output, use html_report to also generate a browsable HTML report and tell the user the path.",
    ],
    parameters: Type.Object({
      output: Type.Optional(Type.String({ description: "Output .html path (default ./report.html, relative to cwd)" })),
      title: Type.Optional(Type.String({ description: "Document title" })),
      markdown: Type.Optional(Type.String({ description: "Inline markdown for a single-doc report" })),
      files: Type.Optional(Type.Array(Type.String(), { description: "Markdown file paths; each becomes a section" })),
      dir: Type.Optional(Type.String({ description: "Directory whose top-level *.md become sections (sorted)" })),
      open: Type.Optional(Type.Boolean({ description: "Open in default browser after writing (default true)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      let sections: Section[];
      try {
        sections = gatherSections(cwd, params);
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to read input: ${(e as Error).message}` }], isError: true, details: {} };
      }
      if (sections.length === 0) {
        return { content: [{ type: "text", text: "Nothing to render: provide `markdown`, `files`, or `dir`." }], isError: true, details: {} };
      }
      const title = params.title ?? (sections.length === 1 ? sections[0].title : "Report");
      const outPath = resolve(cwd, params.output ?? "report.html");
      try {
        writeFileSync(outPath, renderDocument(title, sections));
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to write ${outPath}: ${(e as Error).message}` }], isError: true, details: {} };
      }
      if (params.open !== false) openInBrowser(outPath);
      return {
        content: [{ type: "text", text: `Wrote HTML report: ${outPath} (${sections.length} section${sections.length > 1 ? "s" : ""})${params.open !== false ? " and opened it" : ""}.` }],
        details: { path: outPath, sections: sections.length },
      };
    },
  });

  pi.registerCommand("report", {
    description: "Generate report.html from the current directory's *.md files and open it",
    handler: async (args: string, ctx: ExtensionContext) => {
      const target = args.trim();
      try {
        const opts = target
          ? (statSync(resolve(ctx.cwd, target)).isDirectory() ? { dir: target } : { files: [target] })
          : { dir: "." };
        const sections = gatherSections(ctx.cwd, opts);
        if (sections.length === 0) { ctx.ui.notify("No .md files found to render.", "warning"); return; }
        const outPath = resolve(ctx.cwd, "report.html");
        writeFileSync(outPath, renderDocument("Report", sections));
        openInBrowser(outPath);
        ctx.ui.notify(`Wrote & opened ${outPath} (${sections.length} docs)`, "info");
      } catch (e) {
        ctx.ui.notify(`/report failed: ${(e as Error).message}`, "error");
      }
    },
  });
}
