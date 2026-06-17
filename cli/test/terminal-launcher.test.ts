import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLaunchExecution, tmpEnvFor } from '../src/terminal-launcher.ts';

const AGENT = {
  command: 'claude',
  args: [
    '--append-system-prompt-file',
    '/tmp/ctx.md',
    'Start work on the attached Overlord ticket.'
  ],
  workingDirectory: '/Users/jake/project'
};

test('no launcher runs the agent inline without a shell', () => {
  const exec = resolveLaunchExecution({ ...AGENT });
  assert.equal(exec.useShell, false);
  assert.equal(exec.terminal, null);
  assert.equal(exec.command, 'claude');
  assert.deepEqual(exec.args, AGENT.args);
});

test('a pre-command wraps the inline launch through a shell', () => {
  const exec = resolveLaunchExecution({ ...AGENT, preCommand: 'docker exec -it box' });
  assert.equal(exec.useShell, true);
  assert.equal(exec.terminal, null);
  assert.deepEqual(exec.args, []);
  assert.ok(exec.command.startsWith('docker exec -it box '));
  // Agent invocation is shell-quoted after the wrapper.
  assert.ok(exec.command.includes(`'claude'`));
  assert.ok(exec.command.includes(`'--append-system-prompt-file'`));
});

test('iTerm2 launcher drives osascript to open a new window', () => {
  const exec = resolveLaunchExecution({ ...AGENT, terminalLauncher: 'iTerm2' });
  assert.equal(exec.command, 'osascript');
  assert.equal(exec.useShell, false);
  assert.equal(exec.terminal, 'iTerm2');
  assert.equal(exec.args[0], '-e');
  const script = exec.args[1] ?? '';
  assert.ok(script.includes('tell application "iTerm"'));
  assert.ok(script.includes('create window with default profile'));
  assert.ok(script.includes('write text'));
  assert.ok(script.includes(`cd '/Users/jake/project'`));
  assert.ok(script.includes(`export OVERLORD_TMPDIR='/Users/jake/project/.overlord/tmp'`));
  assert.ok(script.includes(`'claude'`));
});

test('iTerm2 tab placement creates a tab in the current window', () => {
  const exec = resolveLaunchExecution({
    ...AGENT,
    terminalLauncher: 'iTerm2',
    terminalLaunchPlacement: 'tab'
  });
  const script = exec.args[1] ?? '';
  assert.ok(script.includes('create tab with default profile'));
});

test('iTerm2 chord placement splits vertically for cmd+d', () => {
  const exec = resolveLaunchExecution({
    ...AGENT,
    terminalLauncher: 'iTerm2',
    terminalLaunchPlacement: 'chord',
    terminalLaunchChord: 'cmd+d'
  });
  const script = exec.args[1] ?? '';
  assert.ok(script.includes('split vertically with default profile'));
  assert.ok(script.includes('tell second session of current tab'));
});

test('Terminal tab placement opens in the front window', () => {
  const exec = resolveLaunchExecution({
    ...AGENT,
    terminalLauncher: 'Terminal',
    terminalLaunchPlacement: 'tab'
  });
  const script = exec.args[1] ?? '';
  assert.ok(script.includes('do script'));
  assert.ok(script.includes('in front window'));
});

test('generic launcher chord placement activates the app and sends the shortcut', () => {
  const exec = resolveLaunchExecution({
    ...AGENT,
    terminalLauncher: "open -a 'Ghostty' --args",
    terminalLaunchPlacement: 'chord',
    terminalLaunchChord: 'cmd+d'
  });
  assert.equal(exec.useShell, true);
  assert.ok(exec.command.includes(`tell application "Ghostty" to activate`));
  assert.ok(exec.command.includes('keystroke "d" using {command down}'));
});

test('Terminal launcher drives osascript with do script', () => {
  const exec = resolveLaunchExecution({ ...AGENT, terminalLauncher: 'Terminal' });
  assert.equal(exec.command, 'osascript');
  assert.equal(exec.terminal, 'Terminal');
  const script = exec.args[1] ?? '';
  assert.ok(script.includes('tell application "Terminal"'));
  assert.ok(script.includes('do script'));
  assert.ok(script.includes(`cd '/Users/jake/project'`));
});

test('built-in launcher names are case- and alias-insensitive', () => {
  for (const name of ['iterm', 'ITERM2', ' iTerm.app ']) {
    assert.equal(resolveLaunchExecution({ ...AGENT, terminalLauncher: name }).terminal, 'iTerm2');
  }
  for (const name of ['terminal', 'Terminal.app', 'APPLE TERMINAL']) {
    assert.equal(resolveLaunchExecution({ ...AGENT, terminalLauncher: name }).terminal, 'Terminal');
  }
});

test('an unknown launcher value is treated as a prefix command', () => {
  const exec = resolveLaunchExecution({ ...AGENT, terminalLauncher: 'open -a Ghostty --args' });
  assert.equal(exec.useShell, true);
  assert.equal(exec.terminal, 'open -a Ghostty --args');
  assert.deepEqual(exec.args, []);
  assert.ok(exec.command.startsWith('open -a Ghostty --args '));
  assert.ok(exec.command.includes(`'claude'`));
});

test('double quotes in the agent command are escaped for AppleScript', () => {
  const exec = resolveLaunchExecution({
    command: 'codex',
    args: ['say "hi"'],
    workingDirectory: '/tmp/p',
    terminalLauncher: 'Terminal'
  });
  const script = exec.args[1] ?? '';
  // The shell-quoted arg keeps its literal double quotes, escaped for AppleScript.
  assert.ok(script.includes('\\"hi\\"'));
});

test('a pre-command is wrapped inside the new terminal window', () => {
  const exec = resolveLaunchExecution({
    ...AGENT,
    preCommand: 'mise exec --',
    terminalLauncher: 'iTerm2'
  });
  const script = exec.args[1] ?? '';
  assert.ok(script.includes(`mise exec -- 'claude'`));
});

test('tmpEnvFor pins the TMPDIR family to the project .overlord/tmp', () => {
  const env = tmpEnvFor('/Users/jake/project');
  const expected = '/Users/jake/project/.overlord/tmp';
  assert.deepEqual(env, {
    TMPDIR: expected,
    TMP: expected,
    TEMP: expected,
    OVERLORD_TMPDIR: expected
  });
});
