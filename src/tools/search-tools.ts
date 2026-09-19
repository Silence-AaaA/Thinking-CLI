import * as fs from "fs/promises";
import * as path from "path";
import type { Tool, ToolResult } from "./types.js";

export const grepTool: Tool = {
  name: "grep",
  description: `Search for a pattern in files (like grep).
Returns matching file paths and line numbers, NOT the full content.
Use this FIRST to locate where something is, then use read_file to read specific lines.
This is MUCH cheaper than reading entire files.`,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Search pattern (supports regex)",
      },
      path: {
        type: "string",
        description: "Directory or file to search in. Default: current directory",
      },
      filePattern: {
        type: "string",
        description: "File glob pattern (e.g., '*.ts', '*.py'). Default: all files",
      },
      maxResults: {
        type: "number",
        description: "Max number of matches to return. Default: 20",
      },
      contextLines: {
        type: "number",
        description: "Number of context lines around each match. Default: 0",
      },
    },
    required: ["pattern"],
  },
  execute: async (params): Promise<ToolResult> => {
    try {
      const pattern = params["pattern"] as string;
      const searchPath = (params["path"] as string) || ".";
      const maxResults = (params["maxResults"] as number) || 20;
      const contextLines = (params["contextLines"] as number) || 0;

      const regex = new RegExp(pattern, "gi");
      const matches: Array<{
        file: string;
        line: number;
        content: string;
        context?: { before: string[]; after: string[] };
      }> = [];

      async function searchFile(filePath: string): Promise<void> {
        if (matches.length >= maxResults) return;

        try {
          const content = await fs.readFile(filePath, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxResults) break;

            regex.lastIndex = 0;
            if (regex.test(lines[i]!)) {
              const match: {
                file: string;
                line: number;
                content: string;
                context?: { before: string[]; after: string[] };
              } = {
                file: path.relative(searchPath, filePath),
                line: i + 1,
                content: lines[i]!.trim(),
              };

              if (contextLines > 0) {
                const start = Math.max(0, i - contextLines);
                const end = Math.min(lines.length, i + contextLines + 1);
                match.context = {
                  before: lines.slice(start, i).map((l) => l.trim()),
                  after: lines.slice(i + 1, end).map((l) => l.trim()),
                };
              }

              matches.push(match);
            }
          }
        } catch {
          // 跳过无法读取的文件
        }
      }

      async function searchDir(dirPath: string): Promise<void> {
        if (matches.length >= maxResults) return;

        try {
          const entries = await fs.readdir(dirPath, { withFileTypes: true });

          for (const entry of entries) {
            if (matches.length >= maxResults) break;

            if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;

            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
              await searchDir(fullPath);
            } else {
              if (params["filePattern"]) {
                const glob = (params["filePattern"] as string).replace(/\*/g, ".*");
                const fileRegex = new RegExp(`^${glob}$`);
                if (!fileRegex.test(entry.name)) continue;
              }

              await searchFile(fullPath);
            }
          }
        } catch {
          // 跳过无法访问的目录
        }
      }

      const stat = await fs.stat(searchPath);
      if (stat.isFile()) {
        await searchFile(searchPath);
      } else {
        await searchDir(searchPath);
      }

      return {
        success: true,
        data: {
          pattern,
          matchesFound: matches.length,
          matches,
          hint:
            matches.length > 0
              ? `Found ${matches.length} matches. Use read_file with line numbers to see full context.`
              : "No matches found. Try a different pattern or path.",
        },
        tokenEstimate: matches.length * 30,
      };
    } catch (error) {
      return {
        success: false,
        error: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export const findFilesTool: Tool = {
  name: "find_files",
  description: `Find files by name pattern (like find command).
Use this to locate files when you know part of the filename.
Returns matching file paths.`,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Filename pattern (supports wildcards like '*.ts', 'config.*')",
      },
      path: {
        type: "string",
        description: "Directory to search in. Default: current directory",
      },
      maxResults: {
        type: "number",
        description: "Max results. Default: 20",
      },
    },
    required: ["pattern"],
  },
  execute: async (params): Promise<ToolResult> => {
    try {
      const pattern = params["pattern"] as string;
      const searchPath = (params["path"] as string) || ".";
      const maxResults = (params["maxResults"] as number) || 20;

      const glob = pattern.replace(/\*/g, ".*").replace(/\?/g, ".");
      const regex = new RegExp(`^${glob}$`, "i");

      const matches: string[] = [];

      async function findInDir(dirPath: string): Promise<void> {
        if (matches.length >= maxResults) return;

        try {
          const entries = await fs.readdir(dirPath, { withFileTypes: true });

          for (const entry of entries) {
            if (matches.length >= maxResults) break;

            if (entry.name === "node_modules" || entry.name === ".git") continue;

            const fullPath = path.join(dirPath, entry.name);
            const relativePath = path.relative(searchPath, fullPath);

            if (entry.isFile() && regex.test(entry.name)) {
              matches.push(relativePath);
            }

            if (entry.isDirectory()) {
              await findInDir(fullPath);
            }
          }
        } catch {
          // 跳过无法访问的目录
        }
      }

      await findInDir(searchPath);

      return {
        success: true,
        data: {
          pattern,
          matchesFound: matches.length,
          files: matches,
        },
        tokenEstimate: matches.length * 20,
      };
    } catch (error) {
      return {
        success: false,
        error: `Find failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export const searchTools = [grepTool, findFilesTool];
