import { beforeEach, describe, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-bedrock-runtime", async (original) => {
  const actual = await original<typeof import("@aws-sdk/client-bedrock-runtime")>();
  return { ...actual, BedrockRuntimeClient: class { send = send; } };
});
import { parseMessage } from "../src/llm.js";
const valid = { intent: "food_log", day_hint: null, items: [], burn: null, correction: null, question: null, needs_clarification: [], notes: "" };
beforeEach(() => { send.mockReset(); });
describe("Bedrock structured intent", () => {
  it("forces a full required-property tool contract instead of markdown text", async () => {
    send.mockResolvedValue({ output: { message: { content: [{ toolUse: { name: "record_food_intent", input: valid } }] } } });
    expect(await parseMessage("synthetic", [], "2025-01-05T12:00:00Z", "UTC")).toEqual(valid);
    const request = send.mock.calls[0]![0].input;
    expect(request.toolConfig.toolChoice).toEqual({ tool: { name: "record_food_intent" } });
    expect(request.toolConfig.tools[0].toolSpec.inputSchema.json.required).toContain("burn");
  });
  it("retries an incomplete model result once, never inventing missing fields", async () => {
    send.mockResolvedValueOnce({ output: { message: { content: [{ toolUse: { name: "record_food_intent", input: { intent: "food_log" } } }] } } })
      .mockResolvedValueOnce({ output: { message: { content: [{ toolUse: { name: "record_food_intent", input: valid } }] } } });
    expect(await parseMessage("synthetic", [], "2025-01-05T12:00:00Z", "UTC")).toEqual(valid);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("fails explicitly after two malformed responses", async () => {
    send.mockResolvedValue({ output: { message: { content: [{ text: "```json\n{}\n```" }] } } });
    await expect(parseMessage("synthetic", [], "2025-01-05T12:00:00Z", "UTC")).rejects.toThrow(/valid JSON/);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
