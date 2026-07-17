import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLaunchExecution, tmpEnvFor } from '../src/terminal-launcher.ts';

const AGENT = {
  command: 'claude',
  args: [
    '--append-system-prompt-file',
    '/tmp/ctx.md',
    'Start work on the attached Overlord mission.'
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

test('terminal launch exports mission env for connector hooks', () => {
  const exec = resolveLaunchExecution({
    ...AGENT,
    terminalLauncher: 'iTerm2',
    extraEnv: {
      MISSION_ID: 'coo:11',
      OVERLORD_BACKEND_URL: 'http://127.0.0.1:4310',
      OVERLORD_EXECUTION_REQUEST_ID: 'req-123'
    }
  });
  const script = exec.args[1] ?? '';
  assert.ok(script.includes(`export MISSION_ID='coo:11'`));
  assert.ok(script.includes(`export OVERLORD_BACKEND_URL='http://127.0.0.1:4310'`));
  assert.ok(script.includes(`export OVERLORD_EXECUTION_REQUEST_ID='req-123'`));
});

test('custom terminal prefixes receive mission env in the agent command', () => {
  const exec = resolveLaunchExecution({
    ...AGENT,
    terminalLauncher: 'open -a Ghostty --args',
    extraEnv: { MISSION_ID: 'coo:11' }
  });
  assert.ok(exec.command.includes(`env MISSION_ID='coo:11' 'claude'`));
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

test('iTerm2 custom chord runs the keystroke inside a single iTerm tell block', () => {
  const exec = resolveLaunchExecution({
    ...AGENT,
    terminalLauncher: 'iTerm2',
    terminalLaunchPlacement: 'chord',
    terminalLaunchChord: 'cmd+k'
  });
  const script = exec.args[1] ?? '';
  // Regression: the keystroke must not be emitted as a bare top-level `if`
  // outside the tell block, which produced an AppleScript syntax error.
  assert.equal(script.split('\n')[0], 'tell application "iTerm"');
  assert.ok(!script.includes('overlordHadItermWindow'));
  assert.equal((script.match(/tell application "iTerm"/g) ?? []).length, 1);
  // The chord runs only when a window already exists (the else branch), via a
  // one-line System Events tell, after iTerm has been activated.
  assert.ok(
    script.includes('tell application "System Events" to keystroke "k" using {command down}')
  );
  assert.ok(
    script.includes(
      'set overlordSession to current session of (create window with default profile)'
    )
  );
  assert.ok(script.includes('tell overlordSession to write text'));
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

test('multi-line agent prompts are valid AppleScript expressions', () => {
  const exec = resolveLaunchExecution({
    command: 'codex',
    args: ['line one\nif this prompt leaks, AppleScript fails\nline three'],
    workingDirectory: '/tmp/p',
    terminalLauncher: 'iTerm2',
    terminalLaunchPlacement: 'chord',
    terminalLaunchChord: 'cmd+d'
  });
  const script = exec.args[1] ?? '';
  assert.ok(script.includes(' & linefeed & '));
  assert.ok(script.includes('write text ("cd '));
  assert.ok(script.includes('"if this prompt leaks, AppleScript fails"'));
});

test('terminal script path keeps long agent commands out of AppleScript', () => {
  const prompt = `Use the Overlord context file at /Users/jake/.ovld/worktrees/overlord/refactor-the-existing-everhour-time-tracking-152/.overlord/tmp/mission-coo-152.md and attach to mission coo:152.`;
  const exec = resolveLaunchExecution({
    command: 'codex',
    args: ['--model', 'gpt-5.5', prompt],
    workingDirectory:
      '/Users/jake/.ovld/worktrees/overlord/refactor-the-existing-everhour-time-tracking-152',
    terminalLauncher: 'iTerm2',
    terminalScriptPath:
      '/Users/jake/.ovld/worktrees/overlord/refactor-the-existing-everhour-time-tracking-152/.overlord/tmp/launch-coo-152.sh'
  });
  const script = exec.args[1] ?? '';
  assert.ok(script.includes(`/bin/bash '/Users/jake/.ovld/worktrees/overlord/`));
  assert.ok(!script.includes(prompt));
  assert.ok(!script.includes(`'codex' '--model' 'gpt-5.5'`));
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

/** Count `tell`/`end tell` and `if`/`end if` balance for a generated script. */
function blockBalance(script: string): { tell: number; if: number } {
  let tell = 0;
  let ifs = 0;
  for (const raw of script.split('\n')) {
    const line = raw.trim();
    // `tell ... to <command>` is a one-line form that opens no block.
    if (/^tell .+ to /.test(line)) continue;
    if (/^tell /.test(line)) tell += 1;
    else if (line === 'end tell') tell -= 1;
    else if (/^if .+ then$/.test(line)) ifs += 1;
    else if (line === 'end if') ifs -= 1;
  }
  return { tell, if: ifs };
}

test('every osascript placement produces balanced tell/if blocks', () => {
  const launchers = ['iTerm2', 'Terminal'];
  const placements = ['window', 'tab', 'chord'] as const;
  const chords = ['cmd+d', 'cmd+shift+d', 'cmd+k', 'cmd+t'];
  for (const terminalLauncher of launchers) {
    for (const terminalLaunchPlacement of placements) {
      for (const terminalLaunchChord of chords) {
        const exec = resolveLaunchExecution({
          ...AGENT,
          terminalLauncher,
          terminalLaunchPlacement,
          terminalLaunchChord
        });
        if (exec.command !== 'osascript') continue;
        const script = exec.args[1] ?? '';
        const balance = blockBalance(script);
        assert.deepEqual(
          balance,
          { tell: 0, if: 0 },
          `${terminalLauncher} ${terminalLaunchPlacement} ${terminalLaunchChord} unbalanced: ${JSON.stringify(balance)}\n${script}`
        );
      }
    }
  }
});

test('background window launch omits activate for Terminal', () => {
  const exec = resolveLaunchExecution({
    ...AGENT,
    terminalLauncher: 'Terminal',
    terminalLaunchBackground: true
  });
  const script = exec.args[1] ?? '';
  assert.ok(script.includes('tell application "Terminal"'));
  assert.ok(!/^activate$/m.test(script));
  assert.ok(script.includes('do script'));
});

test('background window launch omits activate for iTerm2', () => {
  const exec = resolveLaunchExecution({
    ...AGENT,
    terminalLauncher: 'iTerm2',
    terminalLaunchBackground: true
  });
  const script = exec.args[1] ?? '';
  assert.ok(script.includes('tell application "iTerm"'));
  assert.ok(!/^activate$/m.test(script));
  assert.ok(script.includes('create window with default profile'));
});

test('background is ignored for chord placement so keystrokes reach the app', () => {
  const exec = resolveLaunchExecution({
    ...AGENT,
    terminalLauncher: 'Terminal',
    terminalLaunchPlacement: 'chord',
    terminalLaunchChord: 'cmd+d',
    terminalLaunchBackground: true
  });
  const script = exec.args[1] ?? '';
  assert.ok(/^activate$/m.test(script));
});

test('background generic launcher opens with open -g', () => {
  const exec = resolveLaunchExecution({
    ...AGENT,
    terminalLauncher: "open -a 'Ghostty' --args",
    terminalLaunchBackground: true
  });
  assert.equal(exec.useShell, true);
  assert.ok(exec.command.startsWith("open -g -a 'Ghostty' --args "));
});

test('foreground launch still activates the terminal by default', () => {
  const exec = resolveLaunchExecution({ ...AGENT, terminalLauncher: 'Terminal' });
  const script = exec.args[1] ?? '';
  assert.ok(/^activate$/m.test(script));
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
