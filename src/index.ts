import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Kept in step with package.json. */
export const VERSION = "0.1.0";

/** Pi version this extension is verified against. */
export const PI_BASELINE = "0.84.1";

/** MEMENTO engine CLI this wrapper is pinned to (`memento --version`). */
export const ENGINE_BASELINE = "0.1.0";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("memento", {
    description: "MEMENTO — session memory: recall, journal, consolidate",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`MEMENTO ${VERSION} (pi ${PI_BASELINE}) — lifecycle not yet armed`, "info");
    },
  });
}
