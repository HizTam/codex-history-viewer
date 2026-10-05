import { createHash } from "node:crypto";
import { detectClaudeMaterializedMessageRole } from "./chatAttachments";
import { readClaudeMessageUuid } from "../services/claudeNativeBookmarkReader";

export interface ClaudeQueuedInput {
  inputId: string;
  body: string;
}

export function isClaudeQueuedInputId(value: unknown): value is string {
  return typeof value === "string" && /^ci-[a-f0-9]{32}$/u.test(value);
}

// Keep correlation identifiers host-only and resolve duplicates after the complete scan.
export class ClaudeQueuedInputTracker {
  private readonly materializedUserIds = new Set<string>();
  private readonly inputs = new Map<string, string | undefined>();
  private readonly deliveries = new Set<string>();

  get size(): number { return this.inputs.size; }

  accept(value: unknown, lineIndex: number): ClaudeQueuedInput | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, any>;
    const recordUuid = readClaudeMessageUuid(record.uuid);
    if (detectClaudeMaterializedMessageRole(record) === "user" && recordUuid) {
      this.materializedUserIds.add(recordUuid);
    }
    const attachment = record.attachment;
    if (record.type !== "attachment" || !attachment || typeof attachment !== "object" || Array.isArray(attachment) ||
        attachment.type !== "queued_command" || !attachment.origin || typeof attachment.origin !== "object" ||
        Array.isArray(attachment.origin) || attachment.origin.kind !== "human" ||
        (record.isMeta !== undefined && record.isMeta !== false) ||
        (attachment.isMeta !== undefined && attachment.isMeta !== false) ||
        (attachment.commandMode !== undefined && attachment.commandMode !== "prompt") ||
        (attachment.humanTurn !== undefined && attachment.humanTurn !== true) || attachment.forwardedIntent != null) return undefined;
    const prompt = attachment.prompt;
    let text: string;
    if (typeof prompt === "string") text = prompt;
    else if (Array.isArray(prompt)) {
      const parts: string[] = [];
      for (const block of prompt) {
        if (!block || typeof block !== "object" || Array.isArray(block)) return undefined;
        if (block.type === "text") {
          if (typeof block.text !== "string") return undefined;
          parts.push(block.text);
        }
      }
      text = parts.join("\n");
    } else return undefined;
    const body = text.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim();
    if (!body) return undefined;
    const sourceUuid = readClaudeMessageUuid(attachment.source_uuid) ?? recordUuid;
    const deliveryId = readClaudeMessageUuid(attachment.delivery_id);
    const identity = sourceUuid ? `uuid:${sourceUuid}` : deliveryId ? `delivery:${deliveryId}`
      : Number.isSafeInteger(lineIndex) && lineIndex >= 0 ? `line:${lineIndex}` : undefined;
    if (!identity) return undefined;
    const inputId = `ci-${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32)}`;
    if (this.inputs.has(inputId) || (deliveryId && this.deliveries.has(deliveryId))) return undefined;
    this.inputs.set(inputId, sourceUuid);
    if (deliveryId) this.deliveries.add(deliveryId);
    return { inputId, body };
  }

  isVisible(inputId: string): boolean {
    if (!this.inputs.has(inputId)) return false;
    const source = this.inputs.get(inputId);
    return !source || !this.materializedUserIds.has(source);
  }
}
