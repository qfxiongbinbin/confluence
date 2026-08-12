import {
  editFileTool,
  listDirTool,
  moveFileTool,
  readFileTool,
  searchTool,
  trashFileTool,
  writeFileTool,
} from './fs.js';
import { httpFetchTool } from './http.js';
import { runCommandTool } from './shell.js';
import type { Tool } from './types.js';
import type { ToolDefinition } from '../types.js';

export const BUILTIN_TOOLS: Tool[] = [
  readFileTool,
  listDirTool,
  searchTool,
  writeFileTool,
  editFileTool,
  moveFileTool,
  trashFileTool,
  runCommandTool,
  httpFetchTool,
];

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[] = BUILTIN_TOOLS) {
    for (const t of tools) this.tools.set(t.name, t);
  }

  register(t: Tool): void {
    this.tools.set(t.name, t);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(filter?: string[] | 'all'): Tool[] {
    const all = [...this.tools.values()];
    if (!filter || filter === 'all') return all;
    return all.filter((t) => filter.includes(t.name));
  }

  /** Definitions handed to the model. */
  definitions(filter?: string[] | 'all'): ToolDefinition[] {
    return this.list(filter).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      risk: t.risk,
      ...(t.mutatesFilesystem ? { mutatesFilesystem: true } : {}),
    }));
  }
}

export * from './types.js';
export { readFileTool, listDirTool, searchTool, writeFileTool, editFileTool, moveFileTool, trashFileTool };
export { runCommandTool, httpFetchTool };
