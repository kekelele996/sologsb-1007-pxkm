import { uid } from "./data";
import type { Confidence, ProjectData, Segment, TranscriptTrack, WordMark } from "./types";

/** 词级分词结果：一段连续的字词（中文单字串或字母/数字串）及其在原文中的字符偏移。 */
export interface Token {
  text: string;
  start: number;
  end: number;
}

/** 按标点/空白切分，取出连续的字词。中文按句读标点切，西文按词切。 */
const WORD_RE = /[一-鿿A-Za-z0-9]+/g;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  WORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_RE.exec(text))) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

export type BackfillResult =
  | { ok: true; marks: WordMark[] }
  | { ok: false; reason: string };

/**
 * 旧稿回填：把片段的整段置信度按原级别回填到每个词。
 * 正文为空或切不出词时回填失败，调用方应保持片段原样并展示原因。
 */
export function backfillSegment(segment: Segment): BackfillResult {
  const text = segment.text ?? "";
  if (!text.trim()) {
    return { ok: false, reason: "片段正文为空，无法切分词级标记" };
  }
  const tokens = tokenize(text);
  if (!tokens.length) {
    return { ok: false, reason: "正文不含可切分的词（仅标点或空白）" };
  }
  const marks: WordMark[] = tokens.map((token) => ({
    id: uid("word"),
    start: token.start,
    end: token.end,
    text: token.text,
    confidence: segment.confidence,
  }));
  return { ok: true, marks };
}

export interface MigrationFailure {
  trackId: string;
  trackName: string;
  segmentId: string;
  reason: string;
}

export interface MigrationResult {
  backfilled: number;
  failures: MigrationFailure[];
}

/** 迁移单条轨道：给尚未建立词级标记的片段回填；已有 words 字段的片段跳过。 */
export function migrateTrack(track: TranscriptTrack): MigrationResult {
  let backfilled = 0;
  const failures: MigrationFailure[] = [];
  for (const segment of track.segments) {
    if (segment.words !== undefined) continue;
    const result = backfillSegment(segment);
    if (result.ok) {
      segment.words = result.marks;
      backfilled += 1;
    } else {
      failures.push({
        trackId: track.id,
        trackName: track.name,
        segmentId: segment.id,
        reason: result.reason,
      });
    }
  }
  return { backfilled, failures };
}

/** 迁移整个项目，原地修改。返回回填成功数与失败明细。 */
export function migrateProject(project: ProjectData): MigrationResult {
  let backfilled = 0;
  const failures: MigrationFailure[] = [];
  for (const track of project.tracks) {
    const result = migrateTrack(track);
    backfilled += result.backfilled;
    failures.push(...result.failures);
  }
  return { backfilled, failures };
}

/** 片段整段置信度：词级标记存在时取最小值（木桶效应），否则沿用整段级别。 */
export function segmentConfidence(segment: Segment): Confidence {
  const marks = segment.words;
  if (marks && marks.length) {
    return marks.reduce((min, mark) => (mark.confidence < min ? mark.confidence : min), marks[0].confidence);
  }
  return segment.confidence;
}

/** 用词级标记派生整段置信度与低置信标记，保持旧字段与词级标记一致。 */
export function syncSegmentConfidence(segment: Segment) {
  if (segment.words && segment.words.length) {
    segment.confidence = segmentConfidence(segment);
    segment.flags.lowConfidence = segment.confidence <= 2;
  }
}

/** 在 text 中查找 needle，返回离 near 最近的出现位置；找不到返回 -1。 */
function findNearestOccurrence(text: string, needle: string, near: number): number {
  if (!needle) return -1;
  let best = -1;
  let index = text.indexOf(needle);
  while (index >= 0) {
    if (best < 0 || Math.abs(index - near) < Math.abs(best - near)) best = index;
    index = text.indexOf(needle, index + 1);
  }
  return best;
}

/**
 * 文字改动后重定位词级标记。
 * 标记以原文内容为锚点：能在新文字中找到原词的，平移到新位置；
 * 找不到的标记失效（进入 stale），绝不硬贴旧偏移——整段重录后标记必须重标。
 */
export function relocateMarks(
  newText: string,
  marks: WordMark[],
): { kept: WordMark[]; stale: WordMark[] } {
  const kept: WordMark[] = [];
  const stale: WordMark[] = [];
  for (const mark of marks) {
    const at = findNearestOccurrence(newText, mark.text, mark.start);
    if (at >= 0) {
      kept.push({ ...mark, start: at, end: at + mark.text.length });
    } else {
      stale.push({ ...mark });
    }
  }
  return { kept, stale };
}

/** 把一个标记从“原始片段”映射到修剪（trim）后的新片段中；落在被裁空白区则丢弃。 */
function mapThroughTrim(
  mark: WordMark,
  rawText: string,
  leadTrim: number,
  trailTrim: number,
): WordMark | null {
  const rawLength = rawText.length;
  if (mark.end <= leadTrim || mark.start >= rawLength - trailTrim) return null;
  const start = Math.max(mark.start, leadTrim) - leadTrim;
  const end = Math.min(mark.end, rawLength - trailTrim) - leadTrim;
  if (start >= end) return null;
  return { ...mark, start, end };
}

const trimCounts = (raw: string) => ({
  lead: raw.length - raw.trimStart().length,
  trail: raw.length - raw.trimEnd().length,
});

export interface SplitMarks {
  left: WordMark[];
  right: WordMark[];
  leftStale: WordMark[];
  rightStale: WordMark[];
}

/**
 * 拆分片段时映射词级标记：标记留在原来那几个字上。
 * 分界前的归左段、分界后的归右段，跨分界的标记从分界处夹断到两侧。
 */
export function splitSegmentMarks(segment: Segment, cursor: number): SplitMarks {
  const leftRaw = segment.text.slice(0, cursor);
  const rightRaw = segment.text.slice(cursor);
  const leftTrim = trimCounts(leftRaw);
  const rightTrim = trimCounts(rightRaw);

  const left: WordMark[] = [];
  const right: WordMark[] = [];

  for (const mark of segment.words ?? []) {
    if (mark.end <= cursor) {
      const mapped = mapThroughTrim(mark, leftRaw, leftTrim.lead, leftTrim.trail);
      if (mapped) left.push(mapped);
    } else if (mark.start >= cursor) {
      const shifted: WordMark = { ...mark, start: mark.start - cursor, end: mark.end - cursor };
      const mapped = mapThroughTrim(shifted, rightRaw, rightTrim.lead, rightTrim.trail);
      if (mapped) right.push(mapped);
    } else {
      // 跨分界：夹断成两段，各自映射到所在侧。
      const leftPart: WordMark = { ...mark, start: mark.start, end: cursor };
      const leftMapped = mapThroughTrim(leftPart, leftRaw, leftTrim.lead, leftTrim.trail);
      if (leftMapped && leftMapped.end > leftMapped.start) left.push(leftMapped);
      const rightPart: WordMark = { ...mark, start: 0, end: mark.end - cursor };
      const rightMapped = mapThroughTrim(rightPart, rightRaw, rightTrim.lead, rightTrim.trail);
      if (rightMapped && rightMapped.end > rightMapped.start) right.push(rightMapped);
    }
  }

  // 失效标记没有偏移锚点，按内容归属到仍包含该词的一侧。
  const leftText = leftRaw.trim();
  const rightText = rightRaw.trim();
  const leftStale: WordMark[] = [];
  const rightStale: WordMark[] = [];
  for (const stale of segment.staleMarks ?? []) {
    if (leftText.includes(stale.text)) leftStale.push(stale);
    else if (rightText.includes(stale.text)) rightStale.push(stale);
  }

  return { left, right, leftStale, rightStale };
}

/** 合并片段时映射词级标记：当前段标记保留，下一段标记平移到拼接处之后。 */
export function mergeSegmentMarks(current: Segment, next: Segment): WordMark[] {
  const currentTrim = trimCounts(current.text);
  const nextTrim = trimCounts(next.text);
  const merged: WordMark[] = [];

  for (const mark of current.words ?? []) {
    const mapped = mapThroughTrim(mark, current.text, currentTrim.lead, currentTrim.trail);
    if (mapped) merged.push(mapped);
  }

  const shift = current.text.trim().length + 1; // 合并时两段之间补一个空格
  for (const mark of next.words ?? []) {
    const positioned: WordMark = { ...mark, start: mark.start - nextTrim.lead, end: mark.end - nextTrim.lead };
    merged.push({ ...positioned, start: positioned.start + shift, end: positioned.end + shift });
  }

  merged.sort((a, b) => a.start - b.start);
  return merged;
}

/** 合并两段的失效标记，按文本去重。 */
export function mergeStaleMarks(current: Segment, next: Segment): WordMark[] {
  const seen = new Set<string>();
  const merged: WordMark[] = [];
  for (const stale of [...(current.staleMarks ?? []), ...(next.staleMarks ?? [])]) {
    if (seen.has(stale.text)) continue;
    seen.add(stale.text);
    merged.push(stale);
  }
  return merged;
}

export interface TimedToken extends Token {
  timeStart: number;
  timeEnd: number;
}

/**
 * 把片段时间按字数比例摊到每个词上，得到词级时间区间。
 * 用于方言轨与校订轨的时间轴对齐——词级标记本身没有时间码，只能按字符位置比例推算。
 */
export function timedTokens(segment: Segment): TimedToken[] {
  const duration = segment.end - segment.start;
  const total = Math.max(1, segment.text.length);
  return tokenize(segment.text).map((token) => ({
    ...token,
    timeStart: segment.start + (token.start / total) * duration,
    timeEnd: segment.start + (token.end / total) * duration,
  }));
}

function overlapRatio(a: TimedToken, b: TimedToken): number {
  const overlap = Math.max(0, Math.min(a.timeEnd, b.timeEnd) - Math.max(a.timeStart, b.timeStart));
  const shortest = Math.min(a.timeEnd - a.timeStart, b.timeEnd - b.timeStart);
  return shortest > 0 ? overlap / shortest : 0;
}

export interface AlignToken extends TimedToken {
  /** 在其他轨道的同时间位置能否找到对应词。 */
  aligned: boolean;
}

export interface AlignLane {
  trackId: string;
  trackName: string;
  segmentId: string;
  tokens: AlignToken[];
}

export interface Alignment {
  mine: AlignToken[];
  lanes: AlignLane[];
}

/**
 * 轨间对齐：以当前片段为主轴，找出其他轨道中时间重叠的片段，
 * 按词级时间区间比对，对不上的词（任何重叠轨中都找不到对应）标记 aligned=false。
 */
export function buildAlignment(segment: Segment, tracks: TranscriptTrack[], activeTrackId: string): Alignment {
  const mine: AlignToken[] = timedTokens(segment).map((token) => ({ ...token, aligned: false }));
  const lanes: AlignLane[] = [];

  for (const track of tracks) {
    if (track.id === activeTrackId) continue;
    for (const other of track.segments) {
      const overlaps = other.start < segment.end && other.end > segment.start;
      if (!overlaps) continue;
      const otherTokens: AlignToken[] = timedTokens(other).map((token) => ({ ...token, aligned: false }));
      for (const token of otherTokens) {
        token.aligned = mine.some((own) => overlapRatio(own, token) >= 0.5);
      }
      lanes.push({ trackId: track.id, trackName: track.name, segmentId: other.id, tokens: otherTokens });
    }
  }

  for (const token of mine) {
    token.aligned = lanes.some((lane) => lane.tokens.some((other) => overlapRatio(token, other) >= 0.5));
  }

  return { mine, lanes };
}
