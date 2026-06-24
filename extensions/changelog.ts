import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

export default function (pi: ExtensionAPI) {
  const CHANGELOG_PATH = "CHANGELOG.md";

  // Helper: Check if there are staged changes
  function hasStagedChanges(): boolean {
    try {
      const status = execSync("git diff --cached --name-only", { encoding: "utf-8" });
      return status.trim().length > 0;
    } catch {
      return false;
    }
  }

  // Helper: Check if changelog has been modified in staged changes
  function isChangelogStaged(): boolean {
    try {
      const status = execSync("git diff --cached --name-only", { encoding: "utf-8" });
      return status.split("\n").some((f) => f.trim() === CHANGELOG_PATH);
    } catch {
      return false;
    }
  }

  // Helper: Get list of staged files (excluding changelog)
  function getStagedFiles(): string[] {
    try {
      const status = execSync("git diff --cached --name-only", { encoding: "utf-8" });
      return status
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f && f !== CHANGELOG_PATH);
    } catch {
      return [];
    }
  }

  // Register a tool for the LLM to update the changelog
  pi.registerTool({
    name: "update_changelog",
    label: "Update Changelog",
    description: "Add an entry to CHANGELOG.md for the current changes",
    promptGuidelines: [
      "Before pushing code changes, use update_changelog to document what changed in CHANGELOG.md",
      "Changelog entries should be concise, user-focused, and categorized (Added/Changed/Fixed/Removed)",
    ],
    parameters: Type.Object({
      category: Type.Union([
        Type.Literal("Added"),
        Type.Literal("Changed"),
        Type.Literal("Fixed"),
        Type.Literal("Removed"),
      ]),
      description: Type.String({
        description: "Brief description of the change (can be multi-line)",
      }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const content = readFileSync(CHANGELOG_PATH, "utf-8");
        const lines = content.split("\n");

        // Find the Unreleased section
        const unreleasedIdx = lines.findIndex((l) => l.startsWith("## [Unreleased]"));
        if (unreleasedIdx === -1) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Could not find ## [Unreleased] section in CHANGELOG.md",
              },
            ],
            isError: true,
          };
        }

        // Find or create the category section
        let categoryIdx = -1;
        for (let i = unreleasedIdx + 1; i < lines.length; i++) {
          if (lines[i].startsWith("## ")) break; // Hit next version
          if (lines[i] === `### ${params.category}`) {
            categoryIdx = i;
            break;
          }
        }

        // Format the entry (handle multi-line descriptions)
        const entryLines = params.description
          .split("\n")
          .map((line, idx) => {
            if (idx === 0) return `- ${line}`;
            return `  ${line}`;
          });

        if (categoryIdx === -1) {
          // Need to create the category section
          // Find where to insert (after last existing category or after Unreleased header)
          let insertIdx = unreleasedIdx + 1;
          
          // Skip blank line after Unreleased header if present
          if (insertIdx < lines.length && lines[insertIdx].trim() === "") {
            insertIdx++;
          }

          // Skip to end of existing categories
          while (insertIdx < lines.length && lines[insertIdx].startsWith("###")) {
            insertIdx++;
            // Skip category content
            while (insertIdx < lines.length && !lines[insertIdx].startsWith("###") && !lines[insertIdx].startsWith("## ")) {
              insertIdx++;
            }
          }

          // Insert category with entry
          const categoryOrder = ["Fixed", "Added", "Changed", "Removed"];
          const needsBlankLineBefore = insertIdx > unreleasedIdx + 1 && lines[insertIdx - 1].trim() !== "";
          
          lines.splice(
            insertIdx,
            0,
            ...(needsBlankLineBefore ? [""] : []),
            `### ${params.category}`,
            ...entryLines,
          );
        } else {
          // Insert into existing category (at the top, after the category header)
          lines.splice(categoryIdx + 1, 0, ...entryLines);
        }

        writeFileSync(CHANGELOG_PATH, lines.join("\n"));

        return {
          content: [
            {
              type: "text",
              text: `✓ Added to CHANGELOG.md under ${params.category}:\n${params.description}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error updating changelog: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // Intercept "push" mentions in user input to remind about changelog
  pi.on("before_agent_start", async (event, ctx) => {
    const lowerPrompt = event.prompt.toLowerCase();
    
    if (lowerPrompt.includes("push") || lowerPrompt.includes("commit")) {
      if (hasStagedChanges() && !isChangelogStaged()) {
        const files = getStagedFiles();
        if (files.length > 0) {
          return {
            message: {
              customType: "changelog-reminder",
              content: `⚠️  Staged changes without changelog update:\n${files.slice(0, 5).join("\n")}${files.length > 5 ? `\n... and ${files.length - 5} more` : ""}\n\nConsider using update_changelog before pushing.`,
              display: true,
            },
          };
        }
      }
    }
  });
}
