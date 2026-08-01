// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeCrypto from "node:crypto";

import {
  EventId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  THREAD_TRANSCRIPT_MAX_ACTIVITIES,
  THREAD_TRANSCRIPT_MAX_MESSAGES,
  type ChatAttachment,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";

export interface PiTranscriptImage {
  readonly attachment: ChatAttachment;
  readonly data: Uint8Array;
}

export interface PiActiveTranscript {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly images?: ReadonlyArray<PiTranscriptImage>;
}

type JsonRecord = Record<string, unknown>;

export const PI_TRANSCRIPT_MAX_IMAGES = 100;
export const PI_TRANSCRIPT_MAX_IMAGE_BYTES = 100 * 1024 * 1024;

interface ImageBudget {
  count: number;
  decodedBytes: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      if (!isRecord(part)) return [];
      if (part.type === "text" && typeof part.text === "string") return [part.text];
      if (part.type === "image") return ["[image]"];
      return [];
    })
    .join("\n");
}

function timestamp(value: unknown): string {
  const epochMillis = typeof value === "number" ? value : NaN;
  const parsed = typeof value === "string" ? Date.parse(value) : epochMillis;
  if (!Number.isFinite(parsed)) throw new Error("Pi transcript entry has an invalid timestamp");
  return new Date(parsed).toISOString();
}

function deterministicAttachmentId(threadId: ThreadId, entryId: string, index: number): string {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (threadSegment === null) throw new Error("Pi transcript thread has an invalid attachment id");
  const hash = NodeCrypto.createHash("sha256").update(`${entryId}:${index}`).digest("hex");
  return `${threadSegment}-${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function decodedBase64ByteLength(encoded: string): number | undefined {
  if (encoded.length === 0 || encoded.length % 4 !== 0) return undefined;

  let padding = 0;
  if (encoded.endsWith("==")) padding = 2;
  else if (encoded.endsWith("=")) padding = 1;

  const contentEnd = encoded.length - padding;
  for (let index = 0; index < encoded.length; index += 1) {
    const code = encoded.charCodeAt(index);
    const isAlphabet =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (index < contentEnd ? !isAlphabet : code !== 0x3d) return undefined;
  }

  return (encoded.length / 4) * 3 - padding;
}

function imageAttachments(
  threadId: ThreadId | undefined,
  entryId: string,
  content: unknown,
  budget: ImageBudget,
): {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly images: ReadonlyArray<PiTranscriptImage>;
} {
  if (threadId === undefined || !Array.isArray(content)) return { attachments: [], images: [] };
  const attachments: ChatAttachment[] = [];
  const images: PiTranscriptImage[] = [];
  for (const [index, part] of content.entries()) {
    if (!isRecord(part) || part.type !== "image" || typeof part.data !== "string") continue;
    const mimeType = typeof part.mimeType === "string" ? part.mimeType.toLowerCase() : "";
    if (!mimeType.startsWith("image/"))
      throw new Error("Pi transcript image has an invalid MIME type");

    const decodedBytes = decodedBase64ByteLength(part.data);
    if (
      decodedBytes === undefined ||
      decodedBytes === 0 ||
      decodedBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
    ) {
      throw new Error("Pi transcript image has invalid base64 data or is empty or too large");
    }
    if (budget.count >= PI_TRANSCRIPT_MAX_IMAGES) {
      throw new Error(`Pi transcript contains more than ${PI_TRANSCRIPT_MAX_IMAGES} images`);
    }
    if (budget.decodedBytes + decodedBytes > PI_TRANSCRIPT_MAX_IMAGE_BYTES) {
      throw new Error("Pi transcript images exceed the 100 MiB aggregate limit");
    }

    const data = Buffer.from(part.data, "base64");
    budget.count += 1;
    budget.decodedBytes += decodedBytes;
    const attachment: ChatAttachment = {
      type: "image",
      id: deterministicAttachmentId(threadId, entryId, index),
      name: `pi-image-${index + 1}`,
      mimeType,
      sizeBytes: decodedBytes,
    };
    attachments.push(attachment);
    images.push({ attachment, data });
  }
  return { attachments, images };
}

function activity(
  entryId: string,
  suffix: string,
  summary: string,
  payload: JsonRecord,
  turnId: ReturnType<typeof TurnId.make> | null,
  createdAt: string,
  failed = false,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`pi:${entryId}:${suffix}`),
    tone: failed ? "error" : "tool",
    kind: "tool.completed",
    summary,
    payload,
    turnId,
    createdAt,
  };
}

function message(
  entryId: string,
  role: "user" | "assistant" | "system",
  text: string,
  turnId: ReturnType<typeof TurnId.make> | null,
  createdAt: string,
  attachments: ReadonlyArray<ChatAttachment> = [],
): OrchestrationMessage {
  return {
    id: MessageId.make(`pi:${entryId}`),
    role,
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    turnId,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function activeBranch(entries: ReadonlyArray<unknown>, leafId: string): ReadonlyArray<JsonRecord> {
  const byId = new Map<string, JsonRecord>();
  for (const raw of entries) {
    if (isRecord(raw) && typeof raw.id === "string") byId.set(raw.id, raw);
  }
  if (!byId.has(leafId)) throw new Error(`Pi transcript leaf '${leafId}' was not found`);

  const branch: JsonRecord[] = [];
  const visited = new Set<string>();
  let cursor: string | undefined = leafId;
  while (cursor !== undefined) {
    if (visited.has(cursor)) throw new Error("Pi transcript contains a parent cycle");
    visited.add(cursor);
    const entry = byId.get(cursor);
    if (entry === undefined) throw new Error(`Pi transcript parent '${cursor}' was not found`);
    branch.push(entry);
    cursor = typeof entry.parentId === "string" ? entry.parentId : undefined;
  }
  return branch.toReversed();
}

function retainsMessage(entry: JsonRecord): boolean {
  if (entry.type === "message" && isRecord(entry.message)) {
    const piMessage = entry.message;
    const role = piMessage.role;
    if (role === "user" || role === "assistant") return textContent(piMessage.content).length > 0;
    if (role === "custom" && piMessage.display === true)
      return textContent(piMessage.content).length > 0;
    if (role === "branchSummary" || role === "compactionSummary")
      return typeof piMessage.summary === "string" && piMessage.summary.length > 0;
    return false;
  }
  if (entry.type === "custom_message" && entry.display === true)
    return textContent(entry.content).length > 0;
  return (
    (entry.type === "compaction" || entry.type === "branch_summary") &&
    typeof entry.summary === "string" &&
    entry.summary.length > 0
  );
}

function retainsActivity(entry: JsonRecord): boolean {
  if (entry.type !== "message" || !isRecord(entry.message)) return false;
  return (
    (entry.message.role === "toolResult" && typeof entry.message.toolCallId === "string") ||
    (entry.message.role === "bashExecution" && typeof entry.message.command === "string")
  );
}

function latestIndices(
  branch: ReadonlyArray<JsonRecord>,
  limit: number,
  retain: (entry: JsonRecord) => boolean,
): Set<number> {
  const indices: number[] = [];
  for (let index = branch.length - 1; index >= 0 && indices.length < limit; index -= 1) {
    const entry = branch[index];
    if (entry !== undefined && retain(entry)) indices.push(index);
  }
  return new Set(indices);
}

export function normalizePiActiveTranscript(
  entries: ReadonlyArray<unknown>,
  leafId: string | undefined,
  threadId?: ThreadId,
): PiActiveTranscript {
  if (leafId === undefined) return { messages: [], activities: [], images: [] };

  const branch = activeBranch(entries, leafId);
  for (const entry of branch) {
    timestamp(entry.timestamp);
    if (entry.type === "message" && isRecord(entry.message))
      timestamp(entry.message.timestamp ?? entry.timestamp);
  }
  const retainedMessageIndices = latestIndices(
    branch,
    THREAD_TRANSCRIPT_MAX_MESSAGES,
    retainsMessage,
  );
  const retainedActivityIndices = latestIndices(
    branch,
    THREAD_TRANSCRIPT_MAX_ACTIVITIES,
    retainsActivity,
  );
  const retainedToolCallIds = new Set<string>();
  for (const index of retainedActivityIndices) {
    const entry = branch[index];
    if (
      entry?.type === "message" &&
      isRecord(entry.message) &&
      entry.message.role === "toolResult" &&
      typeof entry.message.toolCallId === "string"
    ) {
      retainedToolCallIds.add(entry.message.toolCallId);
    }
  }

  const messages: OrchestrationMessage[] = [];
  const activities: OrchestrationThreadActivity[] = [];
  const images: PiTranscriptImage[] = [];
  const imageBudget: ImageBudget = { count: 0, decodedBytes: 0 };
  const toolCalls = new Map<
    string,
    {
      readonly entryId: string;
      readonly name: string;
      readonly args: unknown;
      readonly createdAt: string;
      readonly turnId: ReturnType<typeof TurnId.make> | null;
    }
  >();
  let turnId: ReturnType<typeof TurnId.make> | null = null;

  for (const [entryIndex, entry] of branch.entries()) {
    const retainMessage = retainedMessageIndices.has(entryIndex);
    const retainActivity = retainedActivityIndices.has(entryIndex);
    const entryId = typeof entry.id === "string" ? entry.id : "";
    const createdAt = timestamp(entry.timestamp);

    if (entry.type === "message" && isRecord(entry.message)) {
      const piMessage = entry.message;
      const role = piMessage.role;
      const messageCreatedAt = timestamp(piMessage.timestamp ?? entry.timestamp);
      if (role === "user" || role === "assistant") {
        if (role === "user") turnId = TurnId.make(`pi:${entryId}`);
        if (retainMessage) {
          const text = textContent(piMessage.content);
          const materialized = imageAttachments(threadId, entryId, piMessage.content, imageBudget);
          images.push(...materialized.images);
          messages.push(
            message(entryId, role, text, turnId, messageCreatedAt, materialized.attachments),
          );
        }
        if (role === "assistant" && Array.isArray(piMessage.content)) {
          for (const part of piMessage.content) {
            if (
              !isRecord(part) ||
              part.type !== "toolCall" ||
              typeof part.id !== "string" ||
              typeof part.name !== "string" ||
              !retainedToolCallIds.has(part.id)
            )
              continue;
            toolCalls.set(part.id, {
              entryId,
              name: part.name,
              args: part.arguments,
              createdAt: messageCreatedAt,
              turnId,
            });
          }
        }
        continue;
      }
      if (role === "toolResult" && typeof piMessage.toolCallId === "string") {
        const call = toolCalls.get(piMessage.toolCallId);
        if (retainActivity) {
          const name =
            typeof piMessage.toolName === "string" ? piMessage.toolName : (call?.name ?? "Tool");
          const failed = piMessage.isError === true;
          activities.push(
            activity(
              call?.entryId ?? entryId,
              `tool:${piMessage.toolCallId}`,
              name,
              {
                itemType:
                  name === "bash"
                    ? "command_execution"
                    : name === "edit" || name === "write"
                      ? "file_change"
                      : "dynamic_tool_call",
                status: failed ? "failed" : "completed",
                title: name,
                data: {
                  toolCallId: piMessage.toolCallId,
                  toolName: name,
                  ...(call?.args !== undefined ? { args: call.args } : {}),
                  result: textContent(piMessage.content),
                },
              },
              call?.turnId ?? turnId,
              messageCreatedAt,
              failed,
            ),
          );
        }
        toolCalls.delete(piMessage.toolCallId);
        continue;
      }
      if (role === "bashExecution" && typeof piMessage.command === "string" && retainActivity) {
        const failed =
          piMessage.cancelled === true ||
          (typeof piMessage.exitCode === "number" && piMessage.exitCode !== 0);
        activities.push(
          activity(
            entryId,
            "bash",
            "Ran command",
            {
              itemType: "command_execution",
              status: failed ? "failed" : "completed",
              title: "Ran command",
              detail: piMessage.command,
              data: {
                command: piMessage.command,
                output: typeof piMessage.output === "string" ? piMessage.output : "",
                exitCode: typeof piMessage.exitCode === "number" ? piMessage.exitCode : null,
                cancelled: piMessage.cancelled === true,
                truncated: piMessage.truncated === true,
              },
            },
            turnId,
            messageCreatedAt,
            failed,
          ),
        );
        continue;
      }
      if (role === "custom" && piMessage.display === true) {
        const text = textContent(piMessage.content);
        if (retainMessage && text.length > 0)
          messages.push(message(entryId, "system", text, turnId, messageCreatedAt));
        continue;
      }
      if (role === "branchSummary" || role === "compactionSummary") {
        const summary = typeof piMessage.summary === "string" ? piMessage.summary : "";
        if (retainMessage && summary.length > 0)
          messages.push(message(entryId, "system", summary, turnId, messageCreatedAt));
      }
      continue;
    }

    if (entry.type === "custom_message" && entry.display === true) {
      const text = textContent(entry.content);
      if (retainMessage && text.length > 0)
        messages.push(message(entryId, "system", text, turnId, createdAt));
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      const summary = typeof entry.summary === "string" ? entry.summary : "";
      if (retainMessage && summary.length > 0)
        messages.push(message(entryId, "system", summary, turnId, createdAt));
    }
  }

  return {
    messages,
    activities,
    images,
  };
}
