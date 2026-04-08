import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { platform, arch } from "node:os";

export function spawnCloudflared(tunnelToken: string): ChildProcess {
  const child = spawn("cloudflared", ["tunnel", "run", "--token", tunnelToken], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[cloudflared] ${line}`);
  });

  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[cloudflared] ${line}`);
  });

  return child;
}

export async function isCloudflaredInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("cloudflared", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

export async function ensureCloudflared(): Promise<boolean> {
  if (await isCloudflaredInstalled()) return true;

  const command = getInstallCommand();
  if (!command) {
    console.log(
      "Automatic installation not supported on this platform. Install cloudflared manually:",
    );
    console.log(
      "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
    );
    return false;
  }

  // In non-interactive mode (e.g. background daemon where stdin is /dev/null),
  // auto-install without prompting — the user explicitly passed --name so they
  // want a tunnel.
  const isInteractive = process.stdin.isTTY === true;
  if (isInteractive) {
    const approved = await confirm(
      `cloudflared is not installed. Install it with \`${command}\`? [Y/n] `,
    );

    if (!approved) {
      console.log("Skipping cloudflared installation.");
      return false;
    }
  } else {
    console.log(`cloudflared is not installed. Installing automatically...`);
  }

  console.log(`Running: ${command}`);
  try {
    execSync(command, { stdio: "inherit" });
  } catch {
    console.log("Installation failed. You can install manually:");
    console.log(
      "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
    );
    return false;
  }

  return isCloudflaredInstalled();
}

function getInstallCommand(): string | null {
  const os = platform();
  const cpuArch = arch();

  if (os === "darwin") {
    // macOS: use Homebrew
    if (isCommandAvailable("brew")) {
      return "brew install cloudflared";
    }
    return null;
  }

  if (os === "linux") {
    // Debian/Ubuntu: use apt
    if (isCommandAvailable("apt-get")) {
      if (cpuArch === "x64") {
        return "curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb && sudo dpkg -i /tmp/cloudflared.deb && rm /tmp/cloudflared.deb";
      }
      if (cpuArch === "arm64") {
        return "curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o /tmp/cloudflared.deb && sudo dpkg -i /tmp/cloudflared.deb && rm /tmp/cloudflared.deb";
      }
    }
    // Fallback: Homebrew on Linux
    if (isCommandAvailable("brew")) {
      return "brew install cloudflared";
    }
    return null;
  }

  return null;
}

function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() !== "n");
    });
  });
}
