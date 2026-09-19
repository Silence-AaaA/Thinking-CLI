import { exec } from "child_process";
import type { Tool, ToolResult } from "./types.js";

async function gitExec(
  args: string,
  maxOutputLength = 3000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(
      `git ${args}`,
      {
        timeout: 10000,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const truncatedStdout =
          stdout.length > maxOutputLength ? stdout.slice(0, maxOutputLength) + "\n... (truncated)" : stdout;

        resolve({
          stdout: truncatedStdout,
          stderr: stderr || "",
          exitCode: error ? (error.code as number) || 1 : 0,
        });
      },
    );
  });
}

export const gitStatusTool: Tool = {
  name: "git_status",
  description: `Get the current git status in structured format.
Returns: current branch, staged/unstaged/untracked files.
Use this to understand what changes are pending.`,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Repository path. Default: current directory",
      },
    },
  },
  execute: async (_params): Promise<ToolResult> => {
    try {
      const branchResult = await gitExec("rev-parse --abbrev-ref HEAD");
      const branch = branchResult.stdout.trim();

      const statusResult = await gitExec("status --porcelain");

      const staged: string[] = [];
      const unstaged: string[] = [];
      const untracked: string[] = [];

      for (const line of statusResult.stdout.split("\n")) {
        if (!line.trim()) continue;

        const indexStatus = line[0] ?? "";
        const workTreeStatus = line[1] ?? "";
        const filePath = line.slice(3).trim();

        if (indexStatus !== " " && indexStatus !== "?") {
          staged.push(filePath);
        }
        if (workTreeStatus !== " " && workTreeStatus !== "?") {
          unstaged.push(filePath);
        }
        if (indexStatus === "?" && workTreeStatus === "?") {
          untracked.push(filePath);
        }
      }

      return {
        success: true,
        data: {
          branch,
          staged,
          unstaged,
          untracked,
          summary: {
            stagedCount: staged.length,
            unstagedCount: unstaged.length,
            untrackedCount: untracked.length,
          },
        },
        tokenEstimate: 100 + (staged.length + unstaged.length + untracked.length) * 15,
      };
    } catch (error) {
      return {
        success: false,
        error: `Git status failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export const gitDiffTool: Tool = {
  name: "git_diff",
  description: `Show git diff in structured format.
Use stat=true for a quick overview (fewer tokens).
Use stat=false for full diff (more tokens, but shows actual changes).`,
  parameters: {
    type: "object",
    properties: {
      staged: {
        type: "boolean",
        description: "Show staged changes. Default: false (unstaged changes)",
      },
      stat: {
        type: "boolean",
        description: "Show only stats (files changed, insertions, deletions). Default: true",
      },
      file: {
        type: "string",
        description: "Show diff for specific file only",
      },
      maxLines: {
        type: "number",
        description: "Max diff lines to return. Default: 100",
      },
    },
  },
  execute: async (params): Promise<ToolResult> => {
    try {
      const staged = (params["staged"] as boolean) || false;
      const statOnly = params["stat"] !== false;
      const file = params["file"] as string | undefined;
      const maxLines = (params["maxLines"] as number) || 100;

      let cmd = "diff";
      if (staged) cmd += " --cached";
      if (statOnly) cmd += " --stat";
      if (file) cmd += ` -- "${file}"`;

      const result = await gitExec(cmd);

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: `Git diff failed: ${result.stderr}`,
        };
      }

      let output = result.stdout;
      if (!statOnly && output.split("\n").length > maxLines) {
        const lines = output.split("\n").slice(0, maxLines);
        output = lines.join("\n") + "\n... (truncated, use maxLines to see more)";
      }

      return {
        success: true,
        data: {
          type: staged ? "staged" : "unstaged",
          statOnly,
          content: output,
          truncated: output.includes("(truncated)"),
        },
        tokenEstimate: Math.ceil(output.length / 4),
      };
    } catch (error) {
      return {
        success: false,
        error: `Git diff failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export const gitLogTool: Tool = {
  name: "git_log",
  description: `Show git commit history.
Default: last 10 commits in compact format.
Use format="detailed" for more info (more tokens).`,
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Number of commits to show. Default: 10",
      },
      format: {
        type: "string",
        enum: ["compact", "detailed"],
        description: "Output format. compact = one line per commit. Default: compact",
      },
      file: {
        type: "string",
        description: "Show history for specific file only",
      },
    },
  },
  execute: async (params): Promise<ToolResult> => {
    try {
      const limit = (params["limit"] as number) || 10;
      const format = (params["format"] as string) || "compact";
      const file = params["file"] as string | undefined;

      let cmd: string;
      if (format === "detailed") {
        cmd = `log -${limit} --pretty=format:"%H|%an|%ad|%s" --date=short`;
      } else {
        cmd = `log -${limit} --oneline`;
      }

      if (file) cmd += ` -- "${file}"`;

      const result = await gitExec(cmd);

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: `Git log failed: ${result.stderr}`,
        };
      }

      let commits: unknown[];
      if (format === "detailed") {
        commits = result.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [hash, author, date, message] = line.split("|");
            return { hash, author, date, message };
          });
      } else {
        commits = result.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [hash, ...messageParts] = line.split(" ");
            return { hash, message: messageParts.join(" ") };
          });
      }

      return {
        success: true,
        data: {
          commits,
          totalShown: commits.length,
          format,
        },
        tokenEstimate: commits.length * (format === "detailed" ? 40 : 20),
      };
    } catch (error) {
      return {
        success: false,
        error: `Git log failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export const gitTools = [gitStatusTool, gitDiffTool, gitLogTool];
