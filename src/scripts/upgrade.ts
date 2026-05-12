import { spawn } from "node:child_process";

type Step = {
  label: string;
  command: string;
  args: string[];
};

function runStep(step: Step): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log("");
    console.log(`── ${step.label} ─────────────────────────────────────────`);
    console.log(`$ ${[step.command, ...step.args].join(" ")}`);

    const child = spawn(step.command, step.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      shell: false
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${step.command} ${step.args.join(" ")} failed with exit code ${code ?? "unknown"}.`));
    });
  });
}

async function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr.trim() || `${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}.`));
    });
  });
}

async function assertCleanTrackedWorktree(): Promise<void> {
  const status = await capture("git", ["status", "--porcelain", "--untracked-files=no"]);

  if (!status.trim()) {
    return;
  }

  throw new Error(
    "Tracked files have local changes. Commit or stash them before upgrading so git can fast-forward safely.\n\n" +
    status.trim()
  );
}

async function main(): Promise<void> {
  console.log("");
  console.log("╔════════════════════════════════════════╗");
  console.log("║          Kanboard App Upgrade          ║");
  console.log("╚════════════════════════════════════════╝");

  await assertCleanTrackedWorktree();

  const steps: Step[] = [
    { label: "Fetching latest code", command: "git", args: ["pull", "--ff-only"] },
    { label: "Installing dependencies", command: "npm", args: ["install"] },
    { label: "Building app", command: "npm", args: ["run", "build"] }
  ];

  for (const step of steps) {
    await runStep(step);
  }

  console.log("");
  console.log("Upgrade complete. Restart with 'make start'");
}

void main().catch((error) => {
  console.error("");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
