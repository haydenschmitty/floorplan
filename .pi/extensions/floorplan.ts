import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const skillDir = join(extensionDir, "../../skills/floorplan");

/** Make Floorplan's portable Agent Skill and its short Pi command available together. */
export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", () => ({
    skillPaths: [skillDir],
  }));

  pi.registerCommand("floorplan", {
    description: "Create or refresh a Floorplan map of the current project",
    handler: async (args: string) => {
      const request = args.trim();
      await pi.sendUserMessage(
        `/skill:floorplan${request ? ` ${request}` : ""}`,
        { expandPromptTemplates: true },
      );
    },
  });
}
