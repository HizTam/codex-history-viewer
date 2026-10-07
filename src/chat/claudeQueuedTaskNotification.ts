import { createHash } from "node:crypto";
import { readClaudeMessageUuid } from "../services/claudeNativeBookmarkReader";
import { detectClaudeMaterializedMessageRole } from "./chatAttachments";
import { isClaudeQueuedTaskNotificationRecord, projectClaudeTaskNotification } from "./claudeTaskNotification";

interface NotificationDelivery {
  id: string;
  order: number;
  materialized: boolean;
  parent?: NotificationDelivery;
}

type QueuedTaskNotification = ReturnType<typeof projectClaudeTaskNotification> & { notificationId: string };

// Correlation remains host-only; delivered notifications do not consume message indices.
export class ClaudeQueuedTaskNotificationTracker {
  private readonly materializedUserIds = new Set<string>();
  private readonly bySource = new Map<string, NotificationDelivery>();
  private readonly byDelivery = new Map<string, NotificationDelivery>();
  private readonly entries = new Map<string, NotificationDelivery>();

  accept(value: unknown, lineIndex: number, includeDetails = false): QueuedTaskNotification | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const recordUuid = readClaudeMessageUuid(record.uuid);
    if (detectClaudeMaterializedMessageRole(record) === "user" && recordUuid) {
      this.materializedUserIds.add(recordUuid);
      const existing = this.bySource.get(recordUuid);
      if (existing) this.root(existing).materialized = true;
    }
    if (!isClaudeQueuedTaskNotificationRecord(record)) return undefined;
    const attachment = record.attachment as Record<string, unknown>;
    const sourceUuid = readClaudeMessageUuid(attachment.source_uuid) ?? recordUuid;
    const deliveryId = readClaudeMessageUuid(attachment.delivery_id);
    const sourceEntry = sourceUuid ? this.bySource.get(sourceUuid) : undefined;
    const deliveryEntry = deliveryId ? this.byDelivery.get(deliveryId) : undefined;
    let entry = sourceEntry ? this.root(sourceEntry) : deliveryEntry ? this.root(deliveryEntry) : undefined;
    const duplicate = entry !== undefined;
    if (entry && deliveryEntry) entry = this.merge(entry, this.root(deliveryEntry));
    if (!entry) {
      const identity = sourceUuid ? `uuid:${sourceUuid}` : deliveryId ? `delivery:${deliveryId}`
        : Number.isSafeInteger(lineIndex) && lineIndex >= 0 ? `line:${lineIndex}` : undefined;
      if (!identity) return undefined;
      const id = `ctn-${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32)}`;
      if (this.entries.has(id)) return undefined;
      entry = { id, order: this.entries.size, materialized: false };
      this.entries.set(id, entry);
    }
    if (sourceUuid) {
      this.bySource.set(sourceUuid, entry);
      if (this.materializedUserIds.has(sourceUuid)) entry.materialized = true;
    }
    if (deliveryId) this.byDelivery.set(deliveryId, entry);
    if (duplicate || entry.materialized) return undefined;
    return {
      notificationId: entry.id,
      ...projectClaudeTaskNotification({ ...record, uuid: entry.id }, includeDetails),
    };
  }

  isVisible(notificationId: string): boolean {
    const entry = this.entries.get(notificationId);
    if (!entry) return false;
    const root = this.root(entry);
    return root === entry && !root.materialized;
  }

  private root(entry: NotificationDelivery): NotificationDelivery {
    let root = entry;
    while (root.parent) root = root.parent;
    // Compress aliases without recursive calls on untrusted delivery chains.
    while (entry.parent) {
      const parent = entry.parent;
      entry.parent = root;
      entry = parent;
    }
    return root;
  }

  private merge(first: NotificationDelivery, second: NotificationDelivery): NotificationDelivery {
    if (first === second) return first;
    const [earlier, later] = first.order < second.order ? [first, second] : [second, first];
    later.parent = earlier;
    earlier.materialized ||= later.materialized;
    return earlier;
  }
}
