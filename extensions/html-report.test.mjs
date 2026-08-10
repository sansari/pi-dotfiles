#!/usr/bin/env node

// Regression test for ~/.pi/agent/extensions/html-report.ts.
// Ensures numbered lists with blank lines between items do not restart at 1.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
process.env.NODE_PATH = [
  '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules',
  process.env.NODE_PATH,
].filter(Boolean).join(':');
Module.Module._initPaths();

const { createJiti } = require('/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs');
const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });

const extension = jiti('/Users/dare/.pi/agent/extensions/html-report.ts');
let tool;
extension.default({
  registerTool(def) {
    if (def.name === 'html_report') tool = def;
  },
  registerCommand() {},
});

if (!tool) throw new Error('html_report tool was not registered');

const dir = mkdtempSync(join(tmpdir(), 'pi-html-report-'));
try {
  const markdown = [
    '# Numbered List Regression',
    '',
    '1. First item',
    '   Explanation for the first item.',
    '',
    '2. Second item',
    '   Explanation for the second item.',
    '',
    '3. Third item',
    '',
    '   ```txt',
    '   nested code survives',
    '   ```',
    '',
    '- Bullet item',
    '',
    '1. New ordered list should start over intentionally',
    '',
  ].join('\n');
  const result = await tool.execute(
    'test',
    { markdown, output: 'report.html', open: false },
    undefined,
    undefined,
    { cwd: dir },
  );

  if (result.isError) throw new Error(result.content?.[0]?.text ?? 'html_report returned an error');

  const html = readFileSync(join(dir, 'report.html'), 'utf8');
  const contiguousOrderedList = /<ol>\s*<li>First item<p>Explanation for the first item\.<\/p><\/li>\s*<li>Second item<p>Explanation for the second item\.<\/p><\/li>\s*<li>Third item<pre><code>nested code survives<\/code><\/pre><\/li>\s*<\/ol>/;
  if (!contiguousOrderedList.test(html)) {
    throw new Error('blank-line-separated numbered items did not stay in one <ol>');
  }

  const orderedListCount = html.match(/<ol/g)?.length ?? 0;
  if (orderedListCount !== 2) {
    throw new Error(`expected exactly 2 ordered lists; got ${orderedListCount}`);
  }

  console.log('global html_report numbered-list regression passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
