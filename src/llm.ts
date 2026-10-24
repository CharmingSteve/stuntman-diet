import { readFile } from "node:fs/promises";
import { ConverseCommand, BedrockRuntimeClient, type ContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import type { FoodRecord } from "./types.js";

const itemSchema = z.object({
  raw: z.string(),
  food_key: z.string().nullable(),
  match_stage: z.enum(["exact", "alias", "fuzzy", "recent_log", "estimate", "user_number", "unresolved"]),
  display_name: z.string(),
  quantity: z.number().nonnegative().nullable(),
  unit: z.enum(["g", "ml", "unit", "tbsp", "tsp", "portion"]),
  calories: z.number().nonnegative().nullable(),
  calories_source: z.enum(["db", "user_number", "estimate"]),
  confidence: z.enum(["high", "medium", "low"]),
  supersedes_entry_id: z.string().nullable()
}).strict();

const responseSchema = z.object({
  intent: z.enum(["food_log", "burn", "correction", "day_reset", "question", "image", "trend", "unclear"]),
  day_hint: z.enum(["new_day", "same_day"]).nullable(),
  items: z.array(itemSchema),
  burn: z.object({ total: z.number().nonnegative(), components: z.array(z.number().nonnegative()) }).nullable(),
  correction: z.object({
    target: z.string(),
    action: z.enum(["reduce_fraction", "void", "replace"]),
    fraction: z.number().min(0).max(1).nullable()
  }).nullable(),
  question: z.string().nullable(),
  needs_clarification: z.array(z.string()),
  notes: z.string()
}).strict();

export type ParsedMessage = z.infer<typeof responseSchema>;
export type FoodImage = { mediaType: "jpeg" | "png" | "webp"; bytes: Uint8Array };

function promptPath(): string {
  return process.env.SYSTEM_PROMPT_PATH ?? "./docs/stuntman-diet-system-prompt.md";
}

function parseResponse(body: string): ParsedMessage {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("Bedrock response was not valid JSON");
  }
  return responseSchema.parse(value);
}

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" });
const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

async function loadSystemPrompt(): Promise<string> {
  const path = promptPath();
  if (!path.startsWith("s3://")) return readFile(path, "utf8");
  const location = new URL(path);
  const bucket = location.hostname;
  const key = location.pathname.replace(/^\/+/, "");
  if (!bucket || !key) throw new Error("SYSTEM_PROMPT_PATH must identify an S3 object");
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body || !response.ContentLength || response.ContentLength > 256 * 1024) {
    throw new Error("System prompt object is empty or larger than 256 KiB");
  }
  return response.Body.transformToString();
}

export async function parseMessage(
  text: string,
  foods: FoodRecord[],
  clientTime: string,
  timezone: string,
  image?: FoodImage
): Promise<ParsedMessage> {
  const system = await loadSystemPrompt();
  const foodDb = JSON.stringify(foods);
  const prompt = [
    `client_time: ${clientTime}`,
    `profile_timezone: ${timezone}`,
    image ? "An image is attached. Identify the food and estimate portions according to the system prompt." : "",
    `FOOD_DB: ${foodDb}`,
    `USER_MESSAGE: ${text}`
  ].filter(Boolean).join("\n\n");
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const content: ContentBlock[] = [{
      text: attempt === 0 ? prompt : `${prompt}\n\nReturn exactly one valid JSON object matching the required schema.`
    }];
    if (image) content.push({ image: { format: image.mediaType, source: { bytes: image.bytes } } });
    const response = await client.send(new ConverseCommand({
      modelId: process.env.BEDROCK_MODEL ?? "amazon.nova-lite-v1:0",
      system: [{ text: system }],
      messages: [{
        role: "user",
        content
      }],
      inferenceConfig: { maxTokens: 1400, temperature: 0.1 }
    }));
    const textBlock = response.output?.message?.content?.find((block) => "text" in block);
    try {
      if (!textBlock || !("text" in textBlock) || typeof textBlock.text !== "string") {
        throw new Error("Bedrock response did not contain text");
      }
      return parseResponse(textBlock.text);
    } catch (error) {
      lastError = error;
      if (attempt === 1) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Bedrock response could not be parsed");
}

export async function narrateFacts(question: string, facts: Record<string, unknown>): Promise<string> {
  const response = await client.send(new ConverseCommand({
    modelId: process.env.BEDROCK_MODEL ?? "amazon.nova-lite-v1:0",
    system: [{
      text: "Answer the user's question using only the supplied pre-computed facts. Do not calculate totals, infer missing measurements, or claim a medical diagnosis. If the facts do not answer the question, say so briefly. Return exactly one JSON object with a single string property named answer."
    }],
    messages: [{
      role: "user",
      content: [{ text: JSON.stringify({ question, facts }) }]
    }],
    inferenceConfig: { maxTokens: 500, temperature: 0.1 }
  }));
  const text = response.output?.message?.content?.find((block) => "text" in block);
  if (!text || !("text" in text) || typeof text.text !== "string") {
    throw new Error("Bedrock did not return a narration");
  }
  const result = z.object({ answer: z.string().trim().min(1).max(2000) }).strict().parse(JSON.parse(text.text));
  return result.answer;
}

export { responseSchema };
