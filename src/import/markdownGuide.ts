import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface MarkdownGuide {
  rules: string;
  example: string;
}

export async function loadMarkdownGuide(): Promise<MarkdownGuide> {
  const [rules, example] = await Promise.all([
    readGuideFile('docs/markdown-import.md'),
    readGuideFile('examples/testops-markdown-import-example.md'),
  ]);
  return { rules, example };
}

async function readGuideFile(relativePath: string): Promise<string> {
  const filePath = path.resolve(__dirname, '../..', relativePath);
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot load Markdown guide file "${relativePath}": ${message}`, {
      cause: error,
    });
  }
}
