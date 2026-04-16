import { homedir } from "node:os";
import { join } from "node:path";

export type FlamecastPaths = {
  homeDir: string;
  logFile: string;
  pidFile: string;
  credentialsFile: string;
};

export function getFlamecastPaths(): FlamecastPaths {
  const homeDir = process.env.FLAMECAST_HOME ?? join(homedir(), ".flamecast");

  return {
    homeDir,
    logFile: join(homeDir, "flamecast.log"),
    pidFile: join(homeDir, "daemon.pid"),
    credentialsFile: join(homeDir, "credentials.json"),
  };
}
