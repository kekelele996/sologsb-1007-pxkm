import { createSeedProject } from "./data";
import type { BackfillNote, PersistedEnvelope, ProjectData } from "./types";
import { backfillWordMarks, normalizeMarks } from "./word-marks";

export const STORAGE_KEY = "sologsb-1007-project-v1";
export const SESSION_KEY = "sologsb-1007-session";
const MIGRATION_TAB_ID = "schema-migration";

/**
 * 旧稿（schema 1，只有整段置信度）迁移：
 * 把每个片段的原级别回填到该片段的每个字词。
 * 回填失败的片段保持原样（不写 wordMarks、不改置信度），并在项目 backfillNotes 中说明原因。
 */
export function migrateProject(raw: unknown): {
  project: ProjectData;
  revision: number;
  migrated: boolean;
} | null {
  const envelope = raw as { schema?: number; revision?: number; project?: ProjectData } | null;
  if (!envelope || envelope.schema !== 1 || !envelope.project?.tracks?.length) return null;
  const project = structuredClone(envelope.project) as ProjectData;
  // 重新迁移时从干净状态重建说明，保证幂等（失败片段重试不会重复登记）。
  const previousNotes = project.backfillNotes ?? [];
  const notes: BackfillNote[] = [];

  for (const track of project.tracks) {
    for (const segment of track.segments) {
      if (normalizeMarks(segment.text, segment.wordMarks).length) continue; // 已回填过，幂等
      const marks = backfillWordMarks(segment);
      if (marks) {
        segment.wordMarks = marks;
      } else {
        // 已为同一失败片段登记过说明则复用，避免重复。
        const existing = previousNotes.find((note) => note.segmentId === segment.id && note.trackId === track.id);
        notes.push(existing ?? {
          id: `bn-${track.id}-${segment.id}`,
          segmentId: segment.id,
          trackId: track.id,
          trackName: track.name,
          preview: segment.text.trim() ? segment.text.trim().slice(0, 24) : "（空片段）",
          reason: !segment.text.trim()
            ? "片段正文为空，没有可回填的字词；已保留原整段级别"
            : "片段中没有识别到字词（可能全是标点或空白），已保留原整段级别",
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  project.backfillNotes = notes;
  return {
    project,
    revision: (envelope.revision ?? 0) + 1,
    migrated: true,
  };
}

export function loadProject(): { project: ProjectData; revision: number } {
  if (typeof localStorage === "undefined") {
    return { project: createSeedProject(), revision: 0 };
  }
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as
      | PersistedEnvelope
      | { schema?: number };
    // 旧稿：按原级别逐词回填，回填失败的片段保留原样并登记原因。
    if ((raw as { schema?: number })?.schema === 1) {
      const migrated = migrateProject(raw);
      if (migrated) {
        const envelope: PersistedEnvelope = {
          schema: 2,
          revision: migrated.revision,
          tabId: MIGRATION_TAB_ID,
          savedAt: Date.now(),
          project: migrated.project,
        };
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
        } catch {
          // 写回失败不影响本次会话使用迁移结果，自动保存会稍后再试。
        }
        return { project: migrated.project, revision: migrated.revision };
      }
    }
    const parsed = raw as PersistedEnvelope;
    if (parsed?.schema === 2 && parsed.project?.tracks?.length) {
      return { project: parsed.project, revision: parsed.revision ?? 0 };
    }
  } catch {
    // A malformed local draft falls back to the bundled sample.
  }
  return { project: createSeedProject(), revision: 0 };
}

export function saveProject(project: ProjectData, revision: number, tabId: string) {
  const envelope: PersistedEnvelope = {
    schema: 2,
    revision,
    tabId,
    savedAt: Date.now(),
    project,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  return envelope;
}

export function readEnvelope(): PersistedEnvelope | null {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as PersistedEnvelope;
  } catch {
    return null;
  }
}

export function downloadText(filename: string, content: string, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function formatTime(seconds: number, withMillis = true) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const head = [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
  return withMillis ? `${head}.${String(ms).padStart(3, "0")}` : head;
}

export function parseTime(value: string) {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(normalized) || 0;
}
