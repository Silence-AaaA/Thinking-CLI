import type { Tool, ToolResult } from "./types.js";
import * as fs from "fs/promises";
import * as path from "path";

export const fileSummaryTool: Tool = {
  name: "file_summary",
  description: `Get a summary of a file's structure (functions, classes, exports).
Use this BEFORE reading the full file to understand what it contains.
This is much cheaper than reading the entire file.
Returns: line count, language, main exports/functions.`,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file (relative to workspace root)",
      },
    },
    required: ["path"],
  },
  execute: async (params): Promise<ToolResult> => {
    try {
      const filePath = params["path"] as string;
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");
      
      const functions: string[] = [];
      const classes: string[] = [];
      const exports: string[] = [];
      
      for (const line of lines) {
        const trimmed = line.trim();
        const funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
        if (funcMatch) functions.push(funcMatch[1]!);
        
        const classMatch = trimmed.match(/^(?:export\s+)?class\s+(\w+)/);
        if (classMatch) classes.push(classMatch[1]!);
        
        if (trimmed.startsWith("export ")) {
          const exportMatch = trimmed.match(/export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)/);
          if (exportMatch) exports.push(exportMatch[1]!);
        }
      }
      
      const ext = path.extname(filePath);
      
      return {
        success: true,
        data: {
          path: filePath,
          lines: lines.length,
          language: ext.slice(1) || "unknown",
          functions: functions.slice(0, 20),
          classes: classes.slice(0, 10),
          exports: exports.slice(0, 20),
        },
        tokenEstimate: 80,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export const readFileTool: Tool = {
  name: "read_file",
  description: `Read file content with optional line range.
For large files, ALWAYS specify start/end lines to avoid wasting tokens.
If no range specified, reads first 200 lines max.
Tip: Use file_summary first to understand structure, then read specific sections.`,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file",
      },
      start: {
        type: "number",
        description: "Start line (1-based, inclusive). Default: 1",
      },
      end: {
        type: "number",
        description: "End line (1-based, inclusive). Default: start + 199",
      },
    },
    required: ["path"],
  },
  execute: async (params): Promise<ToolResult> => {
    try {
      const filePath = params["path"] as string;
      const start = Math.max(1, (params["start"] as number) || 1);
      const defaultEnd = start + 199;
      const maxEnd = params["end"] as number | undefined;
      
      const content = await fs.readFile(filePath, "utf-8");
      const allLines = content.split("\n");
      const totalLines = allLines.length;
      
      const end = Math.min(
        maxEnd ?? defaultEnd,
        totalLines
      );
      
      const selectedLines = allLines.slice(start - 1, end);
      const truncated = end < totalLines;
      
      return {
        success: true,
        data: {
          content: selectedLines.join("\n"),
          metadata: {
            totalLines,
            showing: `lines ${start}-${end}`,
            truncated,
            hint: truncated 
              ? `File has ${totalLines} lines. Showing ${selectedLines.length} lines. Use start/end to read other sections.`
              : "Showing complete file.",
          },
        },
        tokenEstimate: Math.ceil(selectedLines.join("\n").length / 4),
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description: `Write content to a file. Creates the file if it doesn't exist.
Warning: This will overwrite existing content. Use read_file first to check current content.`,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file",
      },
      content: {
        type: "string",
        description: "Content to write",
      },
    },
    required: ["path", "content"],
  },
  execute: async (params): Promise<ToolResult> => {
    try {
      const filePath = params["path"] as string;
      const content = params["content"] as string;
      
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      
      await fs.writeFile(filePath, content, "utf-8");
      
      return {
        success: true,
        data: {
          path: filePath,
          bytesWritten: Buffer.byteLength(content, "utf-8"),
          lines: content.split("\n").length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export const listDirTool: Tool = {
  name: "list_dir",
  description: `List files and directories in a path.
Use this to explore the project structure before reading specific files.
Returns file names, sizes, and whether each entry is a file or directory.`,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path to list. Default: current directory",
      },
      maxDepth: {
        type: "number",
        description: "Max depth for recursive listing. Default: 1 (non-recursive)",
      },
    },
  },
  execute: async (params): Promise<ToolResult> => {
    try {
      const dirPath = (params["path"] as string) || ".";
      const maxDepth = (params["maxDepth"] as number) || 1;
      
      async function listRecursive(currentPath: string, depth: number): Promise<unknown[]> {
        if (depth > maxDepth) return [];
        
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        const result = [];
        
        for (const entry of entries) {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          
          const fullPath = path.join(currentPath, entry.name);
          const relativePath = path.relative(dirPath, fullPath);
          
          if (entry.isDirectory()) {
            const children = depth < maxDepth 
              ? await listRecursive(fullPath, depth + 1) 
              : [];
            result.push({
              name: entry.name,
              path: relativePath,
              type: "directory",
              children: children.length > 0 ? children : undefined,
            });
          } else {
            const stat = await fs.stat(fullPath);
            result.push({
              name: entry.name,
              path: relativePath,
              type: "file",
              size: stat.size,
            });
          }
        }
        
        return result;
      }
      
      const entries = await listRecursive(dirPath, 0);
      
      return {
        success: true,
        data: {
          path: dirPath,
          entries,
          totalItems: entries.length,
        },
        tokenEstimate: 100,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to list directory: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export const fileTools = [fileSummaryTool, readFileTool, writeFileTool, listDirTool];
