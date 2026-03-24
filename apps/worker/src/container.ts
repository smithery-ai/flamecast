import { Container } from "@cloudflare/containers";

/**
 * FlamecastRuntime — CF Container class for runtime-bridge instances.
 *
 * Each session gets its own container instance (via idFromName(sessionId)).
 * The container runs the runtime-bridge Docker image, which listens on port 8080.
 * Requests are automatically proxied to that port via the Container base class.
 */
export class FlamecastRuntime extends Container {
  defaultPort = 8080;
  sleepAfter = "10m";
  enableInternet = true;
  envVars = { RUNTIME_SETUP_ENABLED: "true" };

  override onStart() {
    console.log("FlamecastRuntime container started");
  }

  override onStop() {
    console.log("FlamecastRuntime container stopped");
  }

  override onError(error: unknown) {
    console.error("FlamecastRuntime container error:", error);
  }
}
