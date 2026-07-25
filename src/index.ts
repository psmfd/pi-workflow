import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Public contract version for the package entrypoint. */
export const PI_WORKFLOW_API_VERSION = 1;

/** Register the pi-workflow extension. Runtime features are added incrementally. */
export default function registerPiWorkflow(pi: ExtensionAPI): void {
  // The package baseline intentionally registers no commands or tools yet.
  void pi;

  const loadSentinel = process.env["PI_WORKFLOW_LOAD_SENTINEL"];
  if (loadSentinel !== undefined && loadSentinel.length > 0) {
    void process.stdout.write(`${loadSentinel}\n`);
  }
}
