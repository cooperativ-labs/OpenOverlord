export type RunOvldResult = {
    exitCode: number | null;
    stdout: string;
    stderr: string;
};
export declare function runOvld({ args, cwd, env, stdin }: {
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
}): Promise<RunOvldResult>;
//# sourceMappingURL=cli.d.ts.map