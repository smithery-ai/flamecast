import * as acp from "@agentclientprotocol/sdk";
import readline from "node:readline/promises";

export class ExampleClient implements acp.Client {
  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    console.log(`\n🔐 Permission requested: ${params.toolCall.title}`);

    console.log(`\nOptions:`);
    params.options.forEach((option, index) => {
      console.log(`   ${index + 1}. ${option.name} (${option.kind})`);
    });

    while (true) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await rl.question("\nChoose an option: ");
      rl.close();
      const trimmedAnswer = answer.trim();

      const optionIndex = parseInt(trimmedAnswer) - 1;
      if (optionIndex >= 0 && optionIndex < params.options.length) {
        return {
          outcome: {
            outcome: "selected",
            optionId: params.options[optionIndex].optionId,
          },
        };
      } else {
        console.log("Invalid option. Please try again.");
      }
    }
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          console.log(update.content.text);
        } else {
          console.log(`[${update.content.type}]`);
        }
        break;
      case "tool_call":
        console.log(`\n🔧 ${update.title} (${update.status})`);
        break;
      case "tool_call_update":
        console.log(`\n🔧 Tool call \`${update.toolCallId}\` updated: ${update.status}\n`);
        break;
      case "plan":
      case "agent_thought_chunk":
      case "user_message_chunk":
        console.log(`[${update.sessionUpdate}]`);
        break;
      default:
        break;
    }
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    console.error("[Client] Write text file called with:", JSON.stringify(params, null, 2));

    return {};
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    console.error("[Client] Read text file called with:", JSON.stringify(params, null, 2));

    return {
      content: "Mock file content",
    };
  }
}
