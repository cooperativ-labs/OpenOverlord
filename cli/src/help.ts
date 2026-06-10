export function printHelp({ primaryCommand }: { primaryCommand: string }): void {
  console.log(`Overlord CLI

Primary command: ${primaryCommand}

Usage:
  ${primaryCommand} version                    Show the installed CLI version
  ${primaryCommand} help                       Show this help message

More management, protocol, and runner commands are documented in cli/docs/.
`);
}
