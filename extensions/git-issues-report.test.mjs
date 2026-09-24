#!/usr/bin/env node

// Regression tests for /git issues report sectioning and ordering.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const piPackageRoot = process.env.PI_CODING_AGENT_ROOT ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = require(`${piPackageRoot}/node_modules/jiti/lib/jiti.cjs`);
const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
const { formatIssueReportMarkdown } = jiti(fileURLToPath(new URL("./lib/github-issues.ts", import.meta.url)));

if (typeof formatIssueReportMarkdown !== "function") {
  throw new Error("git extension did not export the issue report formatter");
}

function issue(number, title, state, updatedAt, { labels = [], assignees = [] } = {}) {
  return {
    number,
    title,
    body: "",
    state,
    url: `https://github.com/example/project/issues/${number}`,
    updatedAt,
    labels: labels.map((name) => ({ name })),
    assignees: assignees.map((login) => ({ login })),
  };
}

const issues = [
  issue(1, "Assigned work", "OPEN", "2026-09-23T10:00:00Z", { assignees: ["reviewer"] }),
  issue(2, "Labelled work", "OPEN", "2026-09-23T09:00:00Z", { labels: ["status: in-progress"] }),
  issue(3, "PR work", "OPEN", "2026-09-23T08:00:00Z"),
  issue(4, "Low priority follow-up", "OPEN", "2026-09-23T07:00:00Z", { labels: ["priority: Low"] }),
  issue(5, "Earlier follow-up", "OPEN", "2026-09-22T07:00:00Z"),
  issue(6, "Finished work", "CLOSED", "2026-09-21T07:00:00Z", { assignees: ["reviewer"] }),
];
const pullRequests = [{
  number: 30,
  body: "",
  state: "OPEN",
  url: "https://github.com/example/project/pull/30",
  updatedAt: "2026-09-23T08:00:00Z",
  closingIssuesReferences: [{ number: 3 }],
}];
const report = formatIssueReportMarkdown(issues, pullRequests);
const done = report.split("*Done:*\n")[1].split("\n\n*In Progress:*")[0];
const inProgress = report.split("*In Progress:*\n")[1].split("\n\n*Next:*")[0];
const next = report.split("*Next:*\n")[1];

assert.ok(report.startsWith("*Done:*"), "Done should be the first section");
assert.ok(report.indexOf("*Done:*") < report.indexOf("*In Progress:*"));
assert.ok(report.indexOf("*In Progress:*") < report.indexOf("*Next:*"));
assert.ok(!report.includes("**"), "section labels should be italicized, not bolded");
for (const title of ["Assigned work", "Labelled work", "PR work"]) {
  assert.ok(inProgress.includes(title), `${title} should be in In progress`);
  assert.ok(!next.includes(title), `${title} must not be in Next`);
}
assert.ok(next.indexOf("Low priority follow-up") < next.indexOf("Earlier follow-up"), "Next should be latest-first");
assert.ok(next.includes("Low priority follow-up"), "Next should not filter by priority");
assert.ok(!next.includes("Finished work"), "closed issues must not be in Next");
assert.ok(done.includes("Finished work"), "closed issues should be in Done");
assert.ok(!done.includes("Assigned work"), "open issues must not be in Done");

const emptyReport = formatIssueReportMarkdown([], []);
assert.equal((emptyReport.match(/- None/g) ?? []).length, 3, "empty sections should show None");

console.log("git issues report sectioning tests passed");
