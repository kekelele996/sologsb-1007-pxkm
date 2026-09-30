import type { Confidence, Segment, TranscriptTrack, WordMark } from "./types";

/** 跨轨对齐时，两个词标记时间区间允许的最大错开秒数。 */
export const ALIGN_TOLERANCE = 0.8;
/** 新旧文本相似度低于该比例时视为整段重录，词标记全部失效。 */
export const RERECORD_RATIO = 0.5;

/* ------------------------------------------------------------------ */
/* 分词                                                                */
/* ------------------------------------------------------------------ */

const isCjk = (ch: string) =>
  /[⺀-⻿㐀-䶿一-鿿豈-﫿぀-ヿㇰ-ㇿ㈀-㋾ꀀ-꒿가-힯]/.test(ch);
const isWordChar = (ch: string) => /[\p{L}\p{N}]/u.test(ch);

/**
 * 把正文切成“字词”区间（[start, end)，字符偏移）。
 * 中文/日文/谚文按字切分；拉丁字母与数字按连续串切分；标点空格不属于任何词。
 */
export function tokenize(text: string): Array<{ start: number; end: number; text: string }> {
  const tokens: Array<{ start: number; end: number; text: string }> = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (isCjk(ch)) {
      tokens.push({ start: i, end: i + 1, text: ch });
      i += 1;
      continue;
    }
    if (isWordChar(ch)) {
      const start = i;
      while (i < text.length && isWordChar(text[i]) && !isCjk(text[i])) i += 1;
      tokens.push({ start, end: i, text: text.slice(start, i) });
      continue;
    }
    i += 1;
  }
  return tokens;
}

/* ------------------------------------------------------------------ */
/* 标记归一化与综合置信度                                              */
/* ------------------------------------------------------------------ */

/** 去重、裁到文本范围内、按起点排序的有效词标记。 */
export function normalizeMarks(text: string, marks: WordMark[] | undefined): WordMark[] {
  if (!marks) return [];
  const seen = new Set<string>();
  const result: WordMark[] = [];
  for (const mark of marks) {
    if (!Number.isInteger(mark.start) || !Number.isInteger(mark.end)) continue;
    const start = Math.max(0, mark.start);
    const end = Math.min(text.length, mark.end);
    if (end <= start) continue;
    if (!text.slice(start, end).trim()) continue;
    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ start, end, confidence: mark.confidence });
  }
  return result.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** 片段内置信度最低的词（无标记返回 null）。 */
export function minWordConfidence(segment: Pick<Segment, "text" | "wordMarks">): Confidence | null {
  const marks = normalizeMarks(segment.text, segment.wordMarks);
  if (!marks.length) return null;
  return marks.reduce<Confidence>((min, mark) => (mark.confidence < min ? mark.confidence : min), 5);
}

/**
 * 片段综合置信度：被标记的词按字符长度加权，未标记的字符按基准置信度，
 * 四舍五入到 1—5。这样一两个低置信词只会轻微拉低整段，而不是全段可疑。
 */
export function effectiveConfidence(
  segment: Pick<Segment, "text" | "confidence" | "wordMarks">,
): Confidence {
  const marks = normalizeMarks(segment.text, segment.wordMarks);
  if (!marks.length) return segment.confidence;
  const total = segment.text.length;
  if (!total) return segment.confidence;
  let weighted = 0;
  let coveredTo = 0;
  for (const mark of marks) {
    if (mark.start > coveredTo) weighted += (mark.start - coveredTo) * segment.confidence;
    weighted += (mark.end - mark.start) * mark.confidence;
    coveredTo = Math.max(coveredTo, mark.end);
  }
  if (coveredTo < total) weighted += (total - coveredTo) * segment.confidence;
  const value = Math.round(weighted / total);
  return Math.max(1, Math.min(5, value)) as Confidence;
}

/** 是否存在低置信（≤2）的词。 */
export function hasLowWord(segment: Pick<Segment, "text" | "wordMarks">): boolean {
  return (minWordConfidence(segment) ?? 5) <= 2;
}

/** 全项目的词级校对统计：被至少一个词标记覆盖的字词数。 */
export function projectWordStats(tracks: TranscriptTrack[]) {
  let marked = 0;
  let total = 0;
  for (const track of tracks) {
    for (const segment of track.segments) {
      const marks = normalizeMarks(segment.text, segment.wordMarks);
      for (const word of tokenize(segment.text)) {
        total += 1;
        if (marks.some((mark) => mark.start <= word.start && mark.end >= word.end)) marked += 1;
      }
    }
  }
  return { marked, total };
}

/* ------------------------------------------------------------------ */
/* 改字 / 重录：标记跟着“原来那几个字”走                               */
/* ------------------------------------------------------------------ */

function lcsLength(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[b.length];
}

export interface RebaseResult {
  marks: WordMark[];
  /** 无法在新文本中定位的旧标记（坐标仍是旧文本坐标，供界面引用原词）。 */
  dropped: WordMark[];
  /** true 表示整段被重新录过，标记已全部作废。 */
  reRecorded: boolean;
}

/**
 * 文本改动后重新锚定词标记：
 * - 新旧文本相似度过低（默认 < 0.5）→ 判定整段重录，全部失效；
 * - 否则按标记所锚定的原文内容在新文本中就近重找位置（取离旧位置最近的一处），
 *   找不到同样内容的标记丢弃。不硬贴旧位置。
 */
export function rebaseWordMarks(
  oldText: string,
  newText: string,
  marks: WordMark[] | undefined,
): RebaseResult {
  const previous = normalizeMarks(oldText, marks);
  if (!previous.length) return { marks: [], dropped: [], reRecorded: false };
  if (oldText === newText) return { marks: previous, dropped: [], reRecorded: false };

  const longest = Math.max(oldText.length, newText.length, 1);
  const similarity = lcsLength(oldText, newText) / longest;
  if (similarity < RERECORD_RATIO) {
    return { marks: [], dropped: previous, reRecorded: true };
  }

  const kept: WordMark[] = [];
  const dropped: WordMark[] = [];
  for (const mark of previous) {
    const content = oldText.slice(mark.start, mark.end);
    if (!content.trim()) continue;
    let at = -1;
    let best = Infinity;
    let from = 0;
    for (;;) {
      const hit = newText.indexOf(content, from);
      if (hit < 0) break;
      const distance = Math.abs(hit - mark.start);
      if (distance < best) {
        best = distance;
        at = hit;
      }
      from = hit + 1;
    }
    if (at < 0) {
      dropped.push(mark);
      continue;
    }
    kept.push({ start: at, end: at + content.length, confidence: mark.confidence });
  }
  return { marks: normalizeMarks(newText, kept), dropped, reRecorded: false };
}

/* ------------------------------------------------------------------ */
/* 拆分 / 合并：标记留在原来那几个字上                                  */
/* ------------------------------------------------------------------ */

/**
 * 在 cursor 处拆分片段。跨界的词标记按字符分别留在两侧并裁掉跨界部分；
 * 标记因此被裁没（只剩空白或零宽）时记入 dropped，由界面提示重新标注。
 */
export function splitWordMarks(
  text: string,
  cursor: number,
  marks: WordMark[] | undefined,
): { first: WordMark[]; second: WordMark[]; dropped: WordMark[]; firstText: string; secondText: string } {
  const all = normalizeMarks(text, marks);
  const rawLeft = text.slice(0, cursor);
  const rawRight = text.slice(cursor);
  const leftText = rawLeft.trim();
  const rightText = rawRight.trim();
  const leadLeft = rawLeft.length - rawLeft.trimStart().length;
  const leadRight = rawRight.length - rawRight.trimStart().length;

  const dropped: WordMark[] = [];
  const left: WordMark[] = [];
  const right: WordMark[] = [];

  for (const mark of all) {
    let survived = false;
    const place = (
      partStart: number,
      partEnd: number,
      rawPart: string,
      partText: string,
      lead: number,
      target: WordMark[],
    ) => {
      if (partEnd <= partStart) return;
      // 原始坐标 → 去掉该侧前导空白后的坐标。
      const start = Math.max(0, Math.min(partStart - lead, partText.length));
      const end = Math.max(0, Math.min(partEnd - lead, partText.length));
      if (end <= start || !partText.slice(start, end).trim()) return;
      target.push({ start, end, confidence: mark.confidence });
      survived = true;
    };
    place(mark.start, Math.min(mark.end, cursor), rawLeft, leftText, leadLeft, left);
    place(Math.max(mark.start, cursor) - cursor, mark.end - cursor, rawRight, rightText, leadRight, right);
    if (!survived) dropped.push(mark);
  }

  return {
    first: normalizeMarks(leftText, left),
    second: normalizeMarks(rightText, right),
    dropped,
    firstText: leftText,
    secondText: rightText,
  };
}

/**
 * 合并两个相邻片段的词标记：以原始坐标拼接后按“原来那几个字”的内容重锚到合并文本，
 * 拼接处空格差异不会让标记贴错位；找不到原词的标记记入 dropped。
 */
export function mergeWordMarks(
  firstText: string,
  firstMarks: WordMark[] | undefined,
  secondText: string,
  secondMarks: WordMark[] | undefined,
): { text: string; marks: WordMark[]; dropped: WordMark[] } {
  const text = `${firstText.trim()} ${secondText.trim()}`;
  const shift = firstText.length + 1; // 旧文本 = `${firstText} ${secondText}`
  const translated = [
    ...normalizeMarks(firstText, firstMarks),
    ...normalizeMarks(secondText, secondMarks).map((mark) => ({
      start: mark.start + shift,
      end: mark.end + shift,
      confidence: mark.confidence,
    })),
  ];
  const rebased = rebaseWordMarks(`${firstText} ${secondText}`, text, translated);
  return { text, marks: rebased.marks, dropped: rebased.dropped };
}

/* ------------------------------------------------------------------ */
/* 旧稿回填：按原整段级别回填到每个词                                   */
/* ------------------------------------------------------------------ */

/**
 * 把旧的整段置信度回填到片段里的每个字词。
 * 回填失败（没有可标记的字词，如纯标点/空白片段）时返回 null，
 * 调用方保留片段原样并记录原因。
 */
export function backfillWordMarks(
  segment: Pick<Segment, "text" | "confidence">,
): WordMark[] | null {
  const tokens = tokenize(segment.text);
  if (!tokens.length) return null;
  return tokens.map((token) => ({
    start: token.start,
    end: token.end,
    confidence: segment.confidence,
  }));
}

/* ------------------------------------------------------------------ */
/* 跨轨时间轴对齐                                                      */
/* ------------------------------------------------------------------ */

export interface TimedWord {
  trackId: string;
  trackName: string;
  segmentId: string;
  start: number;
  end: number;
  text: string;
  mark: WordMark;
}

function timeAt(segment: Segment, offset: number) {
  const span = Math.max(segment.end - segment.start, 0.001);
  return segment.start + span * (offset / Math.max(segment.text.length, 1));
}

/** 收集一条轨在给定时间窗内、带词级标记的词，按字符比例映射到时间轴。 */
export function collectMarkedWords(track: TranscriptTrack, from: number, to: number): TimedWord[] {
  const words: TimedWord[] = [];
  for (const segment of track.segments) {
    if (segment.end < from || segment.start > to) continue;
    const marks = normalizeMarks(segment.text, segment.wordMarks);
    for (const mark of marks) {
      words.push({
        trackId: track.id,
        trackName: track.name,
        segmentId: segment.id,
        start: timeAt(segment, mark.start),
        end: timeAt(segment, mark.end),
        text: segment.text.slice(mark.start, mark.end),
        mark,
      });
    }
  }
  return words.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** 判定两个不同轨的词标记是否按时间轴对得上（允许 gap 秒错开）。 */
export function marksAlign(a: TimedWord, b: TimedWord, tolerance = ALIGN_TOLERANCE): boolean {
  if (a.trackId === b.trackId) return false;
  const gap = Math.max(0, Math.max(a.start, b.start) - Math.min(a.end, b.end));
  return gap <= tolerance;
}

export interface AlignmentRow {
  word: TimedWord;
  aligned: boolean;
  reason: string;
}

/**
 * 以一个片段为中心，与指定对比轨做词级对齐。
 * 方言轨和校订轨切分不一致时，靠时间轴（而非文本/序号）配对；
 * 对不上的词 aligned=false，并说明是“对方轨没有这段”还是“有片段但没有对应标记”。
 */
export function alignSegmentWithTrack(segment: Segment, track: TranscriptTrack): AlignmentRow[] {
  const marks = normalizeMarks(segment.text, segment.wordMarks);
  const ownWords: TimedWord[] = marks.map((mark) => ({
    trackId: "",
    trackName: "",
    segmentId: segment.id,
    start: timeAt(segment, mark.start),
    end: timeAt(segment, mark.end),
    text: segment.text.slice(mark.start, mark.end),
    mark,
  }));

  const covering = track.segments.filter(
    (item) => item.end + 0.2 >= segment.start && item.start - 0.2 <= segment.end,
  );
  const otherWords = collectMarkedWords(track, segment.start - 1, segment.end + 1);

  return ownWords.map((word) => {
    const partner = otherWords.find((other) => marksAlign(
      { ...word, trackId: "__self__" },
      other,
    ));
    if (partner) {
      return {
        word,
        aligned: true,
        reason: `与《${track.name}》“${partner.text}”（${partner.start.toFixed(1)}s）时间轴对齐`,
      };
    }
    if (!covering.length) {
      return {
        word,
        aligned: false,
        reason: `《${track.name}》在 ${word.start.toFixed(1)}s–${word.end.toFixed(1)}s 没有对应片段，两轨切分对不上`,
      };
    }
    const preview = covering.map((item) => item.text.slice(0, 10)).join(" / ");
    return {
      word,
      aligned: false,
      reason: `《${track.name}》对应片段（${preview}…）里没有与该词时间轴重合的标记`,
    };
  });
}
