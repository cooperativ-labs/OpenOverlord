import { createInterface } from 'node:readline';

export interface SelectableProject {
  id: string;
  name: string;
  slug: string;
}

/**
 * Parse a 1-based numbered selection against a list of `count` items. Returns the
 * 0-based index when the answer is a whole number inside `1..count`, otherwise
 * `null` (empty input, non-numeric text, or out-of-range numbers).
 */
export function parseNumberedSelection(answer: string, count: number): number | null {
  const trimmed = answer.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(value) || value < 1 || value > count) return null;
  return value - 1;
}

/**
 * Build the lines shown when prompting the user to pick a project. Kept pure so
 * the rendering is unit-testable without a TTY.
 */
export function renderProjectSelection(
  projects: SelectableProject[],
  directoryPath: string
): string[] {
  const lines = [`Current directory:`, `  ${directoryPath}`, ``, `Projects:`];
  projects.forEach((project, index) => {
    lines.push(`  ${index + 1}. ${project.name} (${project.slug})`);
  });
  return lines;
}

export interface PromptForProjectOptions {
  projects: SelectableProject[];
  directoryPath: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/**
 * Interactively prompt the user to choose a project to link the directory with.
 * Lists the projects, reads a 1-based selection, and re-prompts on invalid input.
 * Resolves to the chosen project, or `null` if the user cancels with `q`.
 */
export function promptForProject({
  projects,
  directoryPath,
  input = process.stdin,
  output = process.stdout
}: PromptForProjectOptions): Promise<SelectableProject | null> {
  if (projects.length === 0) {
    return Promise.reject(
      new Error('No projects available. Create one with `ovld create-project`.')
    );
  }

  const rl = createInterface({ input, output });
  const ask = (question: string): Promise<string> =>
    new Promise(resolve => rl.question(question, resolve));

  const run = async (): Promise<SelectableProject | null> => {
    while (true) {
      output.write(`\n${renderProjectSelection(projects, directoryPath).join('\n')}\n`);
      const answer = await ask(
        `\nSelect a project to link this directory with (1-${projects.length}, or 'q' to cancel): `
      );
      if (answer.trim().toLowerCase() === 'q') return null;
      const index = parseNumberedSelection(answer, projects.length);
      if (index !== null) return projects[index] ?? null;
      output.write(`Enter a number between 1 and ${projects.length}.\n`);
    }
  };

  return run().finally(() => rl.close());
}
