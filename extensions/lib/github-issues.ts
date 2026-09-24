import { applySimpleEnglish } from "./plain-english.ts";

export type GitHubIssue = {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  url: string;
  updatedAt: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
};

export type GitHubPullRequest = {
  number: number;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  url: string;
  updatedAt: string;
  closingIssuesReferences: Array<{ number: number }>;
};

function cleanIssueText(text: string): string {
  return applySimpleEnglish(text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/^[-+]\s+\[[ xX]\]\s*/gm, "")
    .replace(/^[-+]\s+/gm, "")
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " "));
}

function bodySection(body: string, names: string[]): string | undefined {
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = body.match(new RegExp(`^#{1,6}\\s+(?:${escaped})\\s*\\r?\\n([\\s\\S]*?)(?=^#{1,6}\\s+|(?![\\s\\S]))`, "im"));
  return match?.[1]?.trim();
}

function issueDetails(issue: GitHubIssue, pullRequests: GitHubPullRequest[]): string {
  const linked = pullRequests
    .filter((pull) => pull.closingIssuesReferences.some((reference) => reference.number === issue.number))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const source = linked[0]?.body || issue.body;
  const focused = bodySection(source, ["Summary", "Outcome", "What changed", "Changes"]);
  const clean = cleanIssueText(focused || source)
    .replace(/^(Summary|Outcome|What changed|Changes)\s*/i, "")
    .trim();
  if (clean) {
    const clipped = clean.length <= 240 ? clean : `${clean.slice(0, 237).replace(/\s+\S*$/, "").trim()}…`;
    return clipped.replace(/[.!?]+$/, "") + ".";
  }
  if (linked[0]) return `${linked[0].state === "MERGED" ? "Merged" : "Work is underway in"} PR #${linked[0].number}.`;
  return issue.state === "CLOSED" ? "Completed and closed." : "Work is underway.";
}

export function issueDescriptor(title: string): string {
  const clean = cleanIssueText(title).replace(/[.!?]+$/, "");
  return clean.length <= 72 ? clean : `${clean.slice(0, 69).replace(/\s+\S*$/, "").trim()}…`;
}

function issueBullet(issue: GitHubIssue, pullRequests: GitHubPullRequest[]): string {
  return `- [${issueDescriptor(issue.title).replace(/[\[\]]/g, "")}](${issue.url}) -- ${issueDetails(issue, pullRequests)}`;
}

function isInProgress(issue: GitHubIssue, pullRequests: GitHubPullRequest[]): boolean {
  if (issue.state !== "OPEN") return false;
  const hasOpenPullRequest = pullRequests.some((pull) =>
    pull.state === "OPEN" && pull.closingIssuesReferences.some((reference) => reference.number === issue.number));
  const hasProgressLabel = issue.labels.some(({ name }) => /^(?:status:\s*)?in[- ]?progress$/i.test(name.trim()));
  return hasOpenPullRequest || hasProgressLabel || issue.assignees.length > 0;
}

export function formatIssueReportMarkdown(issues: GitHubIssue[], pullRequests: GitHubPullRequest[]): string {
  const latestFirst = (left: GitHubIssue, right: GitHubIssue) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  const inProgress = issues.filter((issue) => isInProgress(issue, pullRequests)).sort(latestFirst);
  const next = issues
    .filter((issue) => issue.state === "OPEN" && !isInProgress(issue, pullRequests))
    .sort(latestFirst);
  const done = issues.filter((issue) => issue.state === "CLOSED").sort(latestFirst);
  const section = (title: string, group: GitHubIssue[]) => [
    `*${title}:*`,
    group.length > 0 ? group.map((issue) => issueBullet(issue, pullRequests)).join("\n") : "- None",
  ];

  return [
    ...section("Done", done),
    "",
    ...section("In Progress", inProgress),
    "",
    ...section("Next", next),
  ].join("\n");
}
