import { Checkbox } from "@kobalte/core/checkbox";
import { Dialog } from "@kobalte/core/dialog";
import { Tabs } from "@kobalte/core/tabs";
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { createSeedProject, uid } from "../data";
import { downloadText, formatTime, loadProject, parseTime, saveProject } from "../persistence";
import type { Confidence, PersistedEnvelope, ProjectData, Segment, TranscriptTrack, WordMark } from "../types";
import {
  alignSegmentWithTrack,
  effectiveConfidence,
  hasLowWord,
  mergeWordMarks,
  minWordConfidence,
  normalizeMarks,
  projectWordStats,
  rebaseWordMarks,
  splitWordMarks,
  tokenize,
} from "../word-marks";

const CHANNEL_NAME = "sologsb-1007-editor";
const TAB_ID = uid("tab");
const WORD_CONF_TITLES: Record<number, string> = {
  1: "1 很不确定",
  2: "2 不太确定",
  3: "3 一般",
  4: "4 比较确定",
  5: "5 确定",
};

/** 跨轨对齐面板：方言轨/校订轨切分不一致时，词标记按时间轴配对，对不上的词高亮说明。 */
function AlignmentPanel(props: { segment: Segment; tracks: TranscriptTrack[] }) {
  const [targetId, setTargetId] = createSignal(props.tracks[0]?.id ?? "");
  const targetTrack = createMemo(
    () => props.tracks.find((track) => track.id === targetId()) ?? props.tracks[0] ?? null,
  );
  const rows = createMemo(() => {
    const track = targetTrack();
    return track ? alignSegmentWithTrack(props.segment, track) : [];
  });
  const mismatched = createMemo(() => rows().filter((row) => !row.aligned).length);

  return (
    <div class="alignment-panel">
      <div class="content-title">
        <h3>词级标记跨轨对齐</h3>
        <p>各轨切分方式可能不同，这里不按文字或序号配对，而是把词标记映射到同一条时间轴上比对。</p>
      </div>

      <Show when={props.tracks.length} fallback={<div class="mini-empty">当前项目只有一条文本轨，没有可对齐的对象。</div>}>
        <label class="field-label" for="align-track-select">对比轨道</label>
        <select id="align-track-select" value={targetId()} onChange={(event) => setTargetId(event.currentTarget.value)}>
          <For each={props.tracks}>{(track) => <option value={track.id}>{track.name} · {track.language}</option>}</For>
        </select>

        <Show
          when={rows().length}
          fallback={<div class="mini-empty">当前片段还没有词级标记。先在“校对”页选中听不准的字词进行标记。</div>}
        >
          <div class={`align-summary ${mismatched() ? "has-mismatch" : "all-aligned"}`}>
            {mismatched()
              ? `${mismatched()} / ${rows().length} 个词标记在《${targetTrack()?.name}》对不上`
              : `${rows().length} 个词标记全部按时间轴对齐`}
          </div>
          <ul class="align-list">
            <For each={rows()}>
              {(row) => (
                <li class={row.aligned ? "aligned" : "mismatched"}>
                  <div class="align-word-row">
                    <span class={`align-chip wc${row.word.mark.confidence}`}>{row.word.text}</span>
                    <span class="align-time">{row.word.start.toFixed(1)}s–{row.word.end.toFixed(1)}s</span>
                    <span class="align-status">{row.aligned ? "✓ 对齐" : "⚠ 对不上"}</span>
                  </div>
                  <p>{row.reason}</p>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  );
}

/** 按词标记渲染片段正文，被标过的字词以置信度颜色高亮。 */
function MarkedText(props: { text: string; marks: WordMark[] }) {
  const pieces = createMemo(() => {
    const marks = normalizeMarks(props.text, props.marks);
    if (!marks.length) return [{ text: props.text, mark: null as WordMark | null }];
    const result: Array<{ text: string; mark: WordMark | null }> = [];
    let cursor = 0;
    for (const mark of marks) {
      if (mark.start > cursor) result.push({ text: props.text.slice(cursor, mark.start), mark: null });
      result.push({ text: props.text.slice(mark.start, mark.end), mark });
      cursor = mark.end;
    }
    if (cursor < props.text.length) result.push({ text: props.text.slice(cursor), mark: null });
    return result;
  });
  return (
    <>
      <For each={pieces()}>
        {(piece) =>
          piece.mark ? (
            <mark class={`word-mark wc${piece.mark.confidence}`} title={WORD_CONF_TITLES[piece.mark.confidence]}>
              {piece.text}
            </mark>
          ) : (
            piece.text
          )
        }
      </For>
    </>
  );
}

function statusText(status: "saved" | "saving" | "offline") {
  if (status === "saving") return "正在保存";
  if (status === "offline") return "离线草稿";
  return "已自动保存";
}

function parseTimedTranscript(input: string, trackName: string): TranscriptTrack {
  const blocks = input.trim().split(/\n\s*\n/);
  const segments: Segment[] = [];
  const srtPattern = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
  const bracketPattern = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*(.*)$/;

  const makeSegment = (start: number, end: number, rawText: string): Segment => {
    const speakerName = rawText.match(/^([^：:]{1,10})[：:]/)?.[1];
    return {
      id: uid("seg"),
      start,
      end,
      speakerId: speakerName ? "sp-custom" : "sp-interviewer",
      text: rawText.replace(/^[^：:]{1,10}[：:]\s*/, ""),
      confidence: 3,
      reviewed: false,
      flags: { lowConfidence: false, dialect: false, properNoun: false },
      wordMarks: [],
      tagIds: [],
      comments: [],
    };
  };

  for (const rawBlock of blocks) {
    const lines = rawBlock.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const srtIndex = lines.findIndex((line) => srtPattern.test(line));
    if (srtIndex >= 0) {
      const match = srtPattern.exec(lines[srtIndex]);
      const text = lines.slice(srtIndex + 1).join(" ");
      segments.push(makeSegment(parseTime(match?.[1] ?? "0"), parseTime(match?.[2] ?? "1"), text));
      continue;
    }
    for (const line of lines) {
      const match = bracketPattern.exec(line);
      if (!match) continue;
      const start = parseTime(match[1]);
      const text = match[2];
      segments.push(makeSegment(start, start + Math.max(3, text.length / 5), text));
    }
  }

  if (!segments.length && input.trim()) {
    input.split("\n").map((line) => line.trim()).filter(Boolean).forEach((text, index) => {
      segments.push(makeSegment(index * 6, index * 6 + 5.4, text));
    });
  }

  return {
    id: uid("track"),
    name: trackName || "导入轨",
    language: "待识别",
    status: "待校对",
    segments,
  };
}

export default function OralHistoryEditor() {
  const loaded = loadProject();
  const [project, setProject] = createSignal<ProjectData>(loaded.project);
  const [revision, setRevision] = createSignal(loaded.revision);
  const [past, setPast] = createSignal<ProjectData[]>([]);
  const [future, setFuture] = createSignal<ProjectData[]>([]);
  const [selectedId, setSelectedId] = createSignal(loaded.project.tracks[0]?.segments[0]?.id ?? "");
  const [saveStatus, setSaveStatus] = createSignal<"saved" | "saving" | "offline">("saved");
  const [lastAction, setLastAction] = createSignal("示例项目已就绪");
  const [conflict, setConflict] = createSignal<PersistedEnvelope | null>(null);
  const [online, setOnline] = createSignal(true);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [commentDraft, setCommentDraft] = createSignal("");
  const [replyDrafts, setReplyDrafts] = createSignal<Record<string, string>>({});
  const [trackFilter, setTrackFilter] = createSignal<"all" | "unreviewed" | "low">("all");
  const [selRange, setSelRange] = createSignal<{ start: number; end: number } | null>(null);
  const [markNotices, setMarkNotices] = createSignal<Record<string, string>>({});
  let editorRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let saveTimer: number | undefined;
  let hydrated = false;
  let dirty = false;

  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;
  const activeTrack = createMemo(() => {
    const data = project();
    return data.tracks.find((track) => track.id === data.activeTrackId) ?? data.tracks[0];
  });
  const activeSegment = createMemo(() => activeTrack()?.segments.find((item) => item.id === selectedId()) ?? null);
  const otherTracks = createMemo(() => project().tracks.filter((track) => track.id !== activeTrack()?.id));
  const visibleSegments = createMemo(() => {
    const segments = activeTrack()?.segments ?? [];
    if (trackFilter() === "unreviewed") return segments.filter((segment) => !segment.reviewed);
    if (trackFilter() === "low") return segments.filter((segment) => hasLowWord(segment));
    return segments;
  });
  const completedPercent = createMemo(() => {
    const segments = project().tracks.flatMap((track) => track.segments);
    if (!segments.length) return 0;
    return Math.round((segments.filter((segment) => segment.reviewed).length / segments.length) * 100);
  });
  const wordStats = createMemo(() => projectWordStats(project().tracks));
  const wordPercent = createMemo(() => {
    const stats = wordStats();
    return stats.total ? Math.round((stats.marked / stats.total) * 100) : 0;
  });
  const reviewedCount = createMemo(
    () => project().tracks.flatMap((track) => track.segments).filter((segment) => segment.reviewed).length,
  );
  const totalCount = createMemo(() => project().tracks.flatMap((track) => track.segments).length);
  const backfillNotes = createMemo(() => project().backfillNotes ?? []);
  const selectedTokens = createMemo(() => {
    const segment = activeSegment();
    const range = selRange();
    if (!segment || !range || range.end <= range.start) return [];
    return tokenize(segment.text).filter(
      (word) => word.end > range.start && word.start < range.end,
    );
  });
  const speakerById = (speakerId: string) =>
    project().speakers.find((speaker) => speaker.id === speakerId) ?? project().speakers[0];
  const tagById = (tagId: string) => project().tags.find((tag) => tag.id === tagId);

  const commit = (label: string, mutate: (draft: ProjectData) => void) => {
    const current = structuredClone(project());
    const next = structuredClone(current);
    mutate(next);
    next.updatedAt = new Date().toISOString();
    batch(() => {
      setPast((items) => [...items.slice(-49), current]);
      setFuture([]);
      setProject(next);
      setRevision((value) => value + 1);
      setLastAction(label);
    });
    dirty = true;
  };

  const commitSegment = (label: string, mutate: (segment: Segment, draft: ProjectData) => void) => {
    const id = selectedId();
    commit(label, (draft) => {
      const track = draft.tracks.find((item) => item.id === draft.activeTrackId);
      const segment = track?.segments.find((item) => item.id === id);
      if (segment) mutate(segment, draft);
    });
  };

  const undo = () => {
    const stack = past();
    if (!stack.length) return;
    const previous = stack[stack.length - 1];
    setFuture((items) => [structuredClone(project()), ...items].slice(0, 50));
    setPast(stack.slice(0, -1));
    setProject(previous);
    setRevision((value) => value + 1);
    setLastAction("已撤销上一步");
    dirty = true;
  };

  const redo = () => {
    const stack = future();
    if (!stack.length) return;
    const next = stack[0];
    setPast((items) => [...items.slice(-49), structuredClone(project())]);
    setFuture(stack.slice(1));
    setProject(next);
    setRevision((value) => value + 1);
    setLastAction("已重做");
    dirty = true;
  };

  const switchTrack = (trackId: string) => {
    commit("切换文本轨", (draft) => {
      draft.activeTrackId = trackId;
      selectedIdSet(draft.tracks.find((track) => track.id === trackId)?.segments[0]?.id ?? "");
    });
    setSelRange(null);
  };

  const selectedIdSet = (id: string) => setSelectedId(id);

  const moveSelection = (direction: 1 | -1) => {
    const segments = activeTrack()?.segments ?? [];
    if (!segments.length) return;
    const index = Math.max(0, segments.findIndex((segment) => segment.id === selectedId()));
    const nextIndex = (index + direction + segments.length) % segments.length;
    setSelectedId(segments[nextIndex].id);
    document.getElementById(`segment-${segments[nextIndex].id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const setMarkNotice = (segmentId: string, message: string) => {
    setMarkNotices((items) => ({ ...items, [segmentId]: message }));
  };

  const describeDropped = (text: string, dropped: WordMark[]) => {
    const words = dropped
      .map((mark) => `“${text.slice(mark.start, mark.end)}”`)
      .filter((word) => word.trim().length > 2);
    return words.length ? `以下词标记未能保留：${words.join("、")}，请重新标注。` : "部分词标记已失效，请重新标注。";
  };

  const splitSelection = () => {
    const segment = activeSegment();
    if (!segment || segment.text.trim().length < 2) return;
    const cursor = editorRef?.selectionStart ?? Math.floor(segment.text.length / 2);
    const safeCursor = Math.max(1, Math.min(cursor, segment.text.length - 1));
    const firstTextRaw = segment.text.slice(0, safeCursor);
    const secondTextRaw = segment.text.slice(safeCursor);
    const firstText = firstTextRaw.trim();
    const secondText = secondTextRaw.trim();
    if (!firstText || !secondText) return;
    const ratio = firstTextRaw.length / segment.text.length;
    const boundary = segment.start + (segment.end - segment.start) * ratio;
    // 词标记留在原来那几个字上：按拆分点裁剪，分别跟随两侧。
    const split = splitWordMarks(segment.text, safeCursor, segment.wordMarks);
    const secondId = uid("seg");
    commit("拆分片段", (draft) => {
      const trackIndex = draft.tracks.findIndex((track) => track.id === draft.activeTrackId);
      if (trackIndex < 0) return;
      const track = draft.tracks[trackIndex];
      const current = track.segments.find((item) => item.id === segment.id);
      if (!current) return;
      current.text = split.firstText;
      current.end = Number(boundary.toFixed(1));
      current.wordMarks = split.first;
      current.flags.lowConfidence = hasLowWord(current);
      const created: Segment = {
        ...structuredClone(current),
        id: secondId,
        start: Number(boundary.toFixed(1)),
        text: split.secondText,
        wordMarks: split.second,
        reviewed: false,
        comments: [],
      };
      created.flags.lowConfidence = hasLowWord(created);
      track.segments.splice(track.segments.indexOf(current) + 1, 0, created);
      setSelectedId(secondId);
    });
    if (split.dropped.length) {
      setMarkNotice(secondId, describeDropped(segment.text, split.dropped));
    }
  };

  const mergeWithNext = () => {
    const track = activeTrack();
    const segment = activeSegment();
    if (!track || !segment) return;
    const index = track.segments.findIndex((item) => item.id === segment.id);
    const next = track.segments[index + 1];
    if (!next) return;
    // 合并时两侧词标记按“原来那几个字”整体平移、重锚。
    const merged = mergeWordMarks(segment.text, segment.wordMarks, next.text, next.wordMarks);
    const mergedBase = Math.min(segment.confidence, next.confidence) as Confidence;
    commitSegment("合并下一片段", (current, draft) => {
      const sourceTrack = draft.tracks.find((item) => item.id === draft.activeTrackId);
      if (!sourceTrack) return;
      current.text = merged.text;
      current.end = next.end;
      current.wordMarks = merged.marks;
      current.confidence = mergedBase;
      current.flags.lowConfidence = hasLowWord(current);
      current.tagIds = [...new Set([...current.tagIds, ...next.tagIds])];
      current.comments.push(...structuredClone(next.comments));
      sourceTrack.segments.splice(index + 1, 1);
      current.reviewed = false;
    });
    if (merged.dropped.length) setMarkNotice(segment.id, describeDropped(`${segment.text} ${next.text}`, merged.dropped));
  };

  const toggleFlag = (flag: keyof Omit<Segment["flags"], "lowConfidence">) => {
    commitSegment("修改校对标记", (segment) => {
      segment.flags[flag] = !segment.flags[flag];
      segment.reviewed = false;
    });
  };

  /** 设置整段基准置信度（没有选词时）。 */
  const setBaseConfidence = (confidence: Confidence) => {
    commitSegment("校正整段基准置信度", (segment) => {
      segment.confidence = confidence;
      segment.flags.lowConfidence = hasLowWord(segment);
      segment.reviewed = false;
    });
  };

  /** 清除当前片段的全部词标记，恢复为整段基准。 */
  const clearWordMarks = () => {
    commitSegment("清除词级标记", (segment) => {
      segment.wordMarks = [];
      segment.flags.lowConfidence = false;
      segment.reviewed = false;
    });
    setMarkNotices((items) => {
      const next = { ...items };
      delete next[selectedId()];
      return next;
    });
  };

  /** 删除某个词标记。 */
  const removeWordMark = (mark: WordMark) => {
    commitSegment("删除词级标记", (segment) => {
      segment.wordMarks = normalizeMarks(segment.text, segment.wordMarks).filter(
        (item) => !(item.start === mark.start && item.end === mark.end),
      );
      segment.flags.lowConfidence = hasLowWord(segment);
      segment.reviewed = false;
    });
  };

  /** 修改某个词标记的置信级别。 */
  const setWordMarkConfidence = (mark: WordMark, confidence: Confidence) => {
    commitSegment("校正词级置信度", (segment) => {
      segment.wordMarks = normalizeMarks(segment.text, segment.wordMarks).map((item) =>
        item.start === mark.start && item.end === mark.end ? { ...item, confidence } : item,
      );
      segment.flags.lowConfidence = hasLowWord(segment);
      segment.reviewed = false;
    });
  };

  /** 给文本框当前选中的字词打置信级别；覆盖与选区相交的旧标记。 */
  const markSelection = (confidence: Confidence) => {
    const segment = activeSegment();
    const range = selRange();
    if (!segment || !range) return;
    const tokens = tokenize(segment.text).filter(
      (word) => word.end > range.start && word.start < range.end,
    );
    if (!tokens) return;
    commitSegment("标记词级置信度", (item) => {
      const from = tokens[0].start;
      const to = tokens[tokens.length - 1].end;
      const kept = normalizeMarks(item.text, item.wordMarks).filter(
        (mark) => mark.end <= from || mark.start >= to,
      );
      item.wordMarks = normalizeMarks(item.text, [...kept, { start: from, end: to, confidence }]);
      item.flags.lowConfidence = hasLowWord(item);
      item.reviewed = false;
    });
  };

  /**
   * 改正文：先按旧文本把词标记重锚到新文本。
   * 整段重录或原词找不到 → 标记失效并说明，不硬贴旧位置。
   */
  const editText = (nextText: string) => {
    const segment = activeSegment();
    if (!segment) return;
    const oldText = segment.text;
    const result = rebaseWordMarks(oldText, nextText, segment.wordMarks);
    commitSegment("校正转写文本", (item) => {
      item.text = nextText;
      item.wordMarks = result.marks;
      item.flags.lowConfidence = hasLowWord(item);
      item.reviewed = false;
    });
    if (result.reRecorded) {
      setMarkNotice(segment.id, "整段文字与原录音稿差异过大，已按重新录写处理，原有的词标记全部失效，请重新标注。");
    } else if (result.dropped.length) {
      setMarkNotice(segment.id, describeDropped(oldText, result.dropped));
    }
  };

  const dismissBackfillNote = (noteId: string) => {
    commit("确认回填说明", (draft) => {
      draft.backfillNotes = (draft.backfillNotes ?? []).filter((note) => note.id !== noteId);
    });
  };

  const dismissMarkNotice = (segmentId: string) => {
    setMarkNotices((items) => {
      const next = { ...items };
      delete next[segmentId];
      return next;
    });
  };

  const addComment = () => {
    const body = commentDraft().trim();
    if (!body) return;
    commitSegment("添加批注", (segment) => {
      segment.comments.unshift({
        id: uid("comment"),
        author: "当前校对员",
        body,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      });
      segment.reviewed = false;
    });
    setCommentDraft("");
  };

  const addReply = (commentId: string) => {
    const body = (replyDrafts()[commentId] ?? "").trim();
    if (!body) return;
    commitSegment("回复批注", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      comment?.replies.push({
        id: uid("reply"),
        author: "当前校对员",
        body,
        createdAt: new Date().toISOString(),
      });
    });
    setReplyDrafts((drafts) => ({ ...drafts, [commentId]: "" }));
  };

  const toggleComment = (commentId: string) => {
    commitSegment("更新批注状态", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    });
  };

  const toggleTag = (tagId: string) => {
    commitSegment("更新主题关联", (segment) => {
      segment.tagIds = segment.tagIds.includes(tagId)
        ? segment.tagIds.filter((id) => id !== tagId)
        : [...segment.tagIds, tagId];
      segment.reviewed = false;
    });
  };

  const exportSrt = () => {
    const lines = activeTrack().segments.map((segment, index) => {
      const speaker = speakerById(segment.speakerId)?.name ?? "未知";
      return `${index + 1}\n${formatTime(segment.start)} --> ${formatTime(segment.end)}\n${speaker}：${segment.text}\n`;
    });
    downloadText(`${project().title}-${activeTrack().name}.srt`, lines.join("\n"), "application/x-subrip;charset=utf-8");
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    const imported = parseTimedTranscript(text, file.name.replace(/\.[^.]+$/, ""));
    if (!imported.segments.length) {
      setLastAction("未识别到带时间码的文本");
      return;
    }
    commit("导入转写文本", (draft) => {
      draft.tracks.push(imported);
      draft.activeTrackId = imported.id;
      setSelectedId(imported.segments[0].id);
    });
  };

  const resolveConflict = (useIncoming: boolean) => {
    const incoming = conflict();
    if (!incoming) return;
    if (useIncoming) {
      setPast((items) => [...items.slice(-49), structuredClone(project())]);
      setProject(structuredClone(incoming.project));
      setRevision(incoming.revision + 1);
      setSelectedId(incoming.project.tracks.find((track) => track.id === incoming.project.activeTrackId)?.segments[0]?.id ?? "");
      setLastAction("已采用其他标签页的版本");
      dirty = true;
    } else {
      setRevision((value) => value + 1);
      setLastAction("已保留本页并覆盖冲突版本");
      dirty = true;
    }
    setConflict(null);
  };

  onMount(() => {
    hydrated = true;
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "sologsb-1007-project-v1" || !event.newValue) return;
      try {
        const incoming = JSON.parse(event.newValue) as PersistedEnvelope;
        if (incoming.tabId !== TAB_ID && incoming.revision > revision()) setConflict(incoming);
      } catch {
        // Ignore unrelated or malformed storage events.
      }
    };
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches("input, textarea, select, [contenteditable='true']");
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        const envelope = saveProject(project(), revision(), TAB_ID);
        setSaveStatus("saved");
        setLastAction("已保存本地草稿");
        channel?.postMessage(envelope);
        return;
      }
      if (editing) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        mergeWithNext();
      } else if (event.key.toLowerCase() === "r" && activeSegment()) {
        event.preventDefault();
        commitSegment("标记片段已校对", (segment) => { segment.reviewed = true; });
      } else if (event.key === "?" || (event.shiftKey && event.key === "/")) {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("storage", handleStorage);
    window.addEventListener("keydown", handleKeydown);
    setOnline(navigator.onLine);
    onCleanup(() => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("keydown", handleKeydown);
    });
  });

  channel?.addEventListener("message", (event: MessageEvent<PersistedEnvelope>) => {
    if (event.data.tabId !== TAB_ID && event.data.revision > revision()) setConflict(event.data);
  });

  createEffect(() => {
    const current = project();
    const currentRevision = revision();
    if (!hydrated) return;
    setSaveStatus(online() ? "saving" : "offline");
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const envelope = saveProject(current, currentRevision, TAB_ID);
      setSaveStatus(online() ? "saved" : "offline");
      if (dirty) {
        channel?.postMessage(envelope);
        dirty = false;
      }
    }, 420);
  });

  onCleanup(() => {
    window.clearTimeout(saveTimer);
    channel?.close();
  });

  const clickSegment = (id: string) => {
    setSelectedId(id);
    setSelRange(null);
    queueMicrotask(() => editorRef?.focus());
  };

  return (
    <div class="app-shell">
      <Show when={conflict()}>
        {(incoming) => (
          <div class="conflict-banner" role="alert">
            <div>
              <strong>检测到另一个标签页修改了同一草稿</strong>
              <span>
                对方版本保存于 {new Date(incoming().savedAt).toLocaleTimeString()}。为避免静默覆盖，请选择要保留的版本。
              </span>
            </div>
            <div class="conflict-actions">
              <button class="btn btn-quiet" onClick={() => resolveConflict(false)}>保留本页</button>
              <button class="btn btn-danger" onClick={() => resolveConflict(true)}>载入对方版本</button>
            </div>
          </div>
        )}
      </Show>

      <Show when={backfillNotes().length}>
        <div class="backfill-banner">
          <div class="backfill-head">
            <strong>旧稿词级回填说明</strong>
            <span>已把旧的整段置信度按原级别回填到每个字词；以下 {backfillNotes().length} 个片段回填失败，保持原样。</span>
          </div>
          <ul class="backfill-list">
            <For each={backfillNotes()}>
              {(note) => (
                <li>
                  <div>
                    <b>《{note.trackName}》片段</b>
                    <code>{note.preview}</code>
                  </div>
                  <span>{note.reason}</span>
                  <button class="btn btn-quiet" onClick={() => dismissBackfillNote(note.id)}>知道了</button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>

      <header class="topbar">
        <div class="brand-mark" aria-hidden="true"><span>口述</span><b>1007</b></div>
        <div class="project-heading">
          <input
            aria-label="项目标题"
            value={project().title}
            onChange={(event) => commit("修改项目标题", (draft) => { draft.title = event.currentTarget.value; })}
          />
          <div class="project-meta">
            <span>{project().interviewee}</span>
            <span>{project().recordingDate}</span>
            <span class={`save-state ${saveStatus()}`}>{statusText(saveStatus())}</span>
          </div>
        </div>
        <div class="top-actions">
          <span class={`network-chip ${online() ? "online" : "offline"}`}>{online() ? "在线" : "离线可编辑"}</span>
          <button class="icon-btn" title="撤销 Ctrl/Cmd+Z" disabled={!past().length} onClick={undo}>↶</button>
          <button class="icon-btn" title="重做 Ctrl/Cmd+Shift+Z" disabled={!future().length} onClick={redo}>↷</button>
          <button class="btn btn-quiet" onClick={() => setHelpOpen(true)}>快捷键 <kbd>?</kbd></button>
          <button class="btn btn-primary" onClick={exportSrt}>导出 SRT</button>
        </div>
      </header>

      <div class="workspace">
        <aside class="left-panel">
          <section class="panel-section overview-card">
            <div class="eyebrow">校对进度</div>
            <div class="progress-row">
              <strong>{completedPercent()}%</strong>
              <span>{reviewedCount()} / {totalCount()} 片段</span>
            </div>
            <div class="progress-track"><i style={{ width: `${completedPercent()}%` }} /></div>
            <div class="progress-row word-progress-row">
              <span class="word-progress-label">词级标记</span>
              <span>{wordStats().marked} / {wordStats().total} 字词 · {wordPercent()}%</span>
            </div>
            <div class="progress-track word-progress-track"><i style={{ width: `${wordPercent()}%` }} /></div>
            <p>标记一改动，片段综合置信度和校对进度会立即重算；修改自动保存在本机，断网后仍可继续校对。</p>
          </section>

          <section class="panel-section">
            <div class="section-title"><h2>文本轨道</h2><span>{project().tracks.length}</span></div>
            <div class="track-list">
              <For each={project().tracks}>
                {(track) => (
                  <button class={`track-card ${track.id === project().activeTrackId ? "active" : ""}`} onClick={() => switchTrack(track.id)}>
                    <span class="track-icon">{track.language === "English" ? "EN" : track.language === "福州话转写" ? "方" : "普"}</span>
                    <span class="track-info"><strong>{track.name}</strong><small>{track.segments.length} 段 · {track.status}</small></span>
                    <span class="track-dot" style={{ background: track.status === "已完成" ? "#15803d" : track.status === "校对中" ? "#d97706" : "#94a3b8" }} />
                  </button>
                )}
              </For>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".srt,.txt,.vtt"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importFile(file);
                event.currentTarget.value = "";
              }}
            />
            <button class="wide-action" onClick={() => fileInputRef?.click()}><span>＋</span> 导入带时间码文本</button>
            <div class="hint">支持 SRT / VTT / 每行 `[00:12] 文本`</div>
          </section>

          <section class="panel-section tag-summary">
            <div class="section-title"><h2>标注实体</h2><span>{project().tags.length}</span></div>
            <div class="legend">
              <span><i style={{ background: "#2563eb" }} />主题</span>
              <span><i style={{ background: "#b45309" }} />事件</span>
              <span><i style={{ background: "#be185d" }} />人物</span>
            </div>
            <p>在右侧“标注”页把当前片段关联到主题、事件和人物。</p>
          </section>
        </aside>

        <main class="transcript-panel">
          <div class="panel-toolbar">
            <div>
              <div class="eyebrow">当前轨道</div>
              <h1>{activeTrack().name}</h1>
            </div>
            <div class="filters" role="group" aria-label="片段筛选">
              <button class={trackFilter() === "all" ? "active" : ""} onClick={() => setTrackFilter("all")}>全部</button>
              <button class={trackFilter() === "unreviewed" ? "active" : ""} onClick={() => setTrackFilter("unreviewed")}>未校对</button>
              <button class={trackFilter() === "low" ? "active" : ""} onClick={() => setTrackFilter("low")}>低置信</button>
            </div>
          </div>

          <div class="transcript-list" role="listbox" aria-label="转写片段">
            <For each={visibleSegments()}>
              {(segment, index) => (
                <article
                  id={`segment-${segment.id}`}
                  role="option"
                  aria-selected={segment.id === selectedId()}
                  class={`segment-card ${segment.id === selectedId() ? "selected" : ""} ${segment.reviewed ? "reviewed" : ""}`}
                  onClick={() => clickSegment(segment.id)}
                >
                  <div class="segment-rail" style={{ background: speakerById(segment.speakerId)?.color ?? "#64748b" }} />
                  <div class="segment-time">
                    <span>{formatTime(segment.start, false)}</span>
                    <small>{formatTime(segment.end, false)}</small>
                  </div>
                  <div class="segment-body">
                    <div class="segment-meta">
                      <b>{speakerById(segment.speakerId)?.name ?? "未知发言人"}</b>
                      <span class={`confidence c${effectiveConfidence(segment)}`}>综合置信 {effectiveConfidence(segment)}/5</span>
                      <Show when={minWordConfidence(segment) !== null}>
                        <span class={`confidence c${minWordConfidence(segment) ?? 3}`}>最低词 {minWordConfidence(segment)}/5</span>
                      </Show>
                      <Show when={hasLowWord(segment)}><span class="pill alert">低置信词</span></Show>
                      <Show when={segment.flags.dialect}><span class="pill dialect">方言</span></Show>
                      <Show when={segment.flags.properNoun}><span class="pill proper">专名</span></Show>
                      <Show when={segment.reviewed}><span class="pill done">✓ 已校对</span></Show>
                    </div>
                    <p><MarkedText text={segment.text} marks={segment.wordMarks ?? []} /></p>
                    <div class="segment-tags">
                      <For each={segment.tagIds.map(tagById).filter(Boolean)}>
                        {(tag) => <span style={{ "--tag-color": tag!.color } as any}>#{tag!.label}</span>}
                      </For>
                    </div>
                  </div>
                  <span class="segment-index">{index() + 1}</span>
                </article>
              )}
            </For>
            <Show when={!visibleSegments().length}>
              <div class="empty-state"><b>没有符合筛选条件的片段</b><span>切换到“全部”继续校对。</span></div>
            </Show>
          </div>
        </main>

        <aside class="inspector">
          <Show when={activeSegment()} fallback={<div class="empty-inspector"><b>选择一个片段</b><p>在中间列表点击片段后即可校正发言人、置信度、标记和批注。</p></div>}>
            {(segment) => (
              <Tabs defaultValue="correct" class="inspector-tabs">
                <Tabs.List class="tab-list">
                  <Tabs.Trigger value="correct">校对</Tabs.Trigger>
                  <Tabs.Trigger value="align">跨轨对齐</Tabs.Trigger>
                  <Tabs.Trigger value="annotate">标注</Tabs.Trigger>
                  <Tabs.Trigger value="comments">批注 <span>{segment().comments.length}</span></Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="correct" class="tab-content">
                  <div class="inspector-heading">
                    <div><span>片段 {activeTrack().segments.findIndex((item) => item.id === segment().id) + 1}</span><strong>{formatTime(segment().start, false)} — {formatTime(segment().end, false)}</strong></div>
                    <button class={`review-button ${segment().reviewed ? "done" : ""}`} onClick={() => commitSegment("标记片段已校对", (item) => { item.reviewed = true; })}>
                      {segment().reviewed ? "✓ 已校对" : "标记已校对"}
                    </button>
                  </div>

                  <label class="field-label" for="speaker-select">发言人</label>
                  <select
                    id="speaker-select"
                    value={segment().speakerId}
                    onChange={(event) => commitSegment("校正发言人", (item) => { item.speakerId = event.currentTarget.value; item.reviewed = false; })}
                  >
                    <For each={project().speakers}>{(speaker) => <option value={speaker.id}>{speaker.name} · {speaker.role}</option>}</For>
                  </select>

                  <div class="time-grid">
                    <label>开始<input type="text" value={formatTime(segment().start)} onChange={(event) => commitSegment("修改开始时间", (item) => { item.start = parseTime(event.currentTarget.value); })} /></label>
                    <label>结束<input type="text" value={formatTime(segment().end)} onChange={(event) => commitSegment("修改结束时间", (item) => { item.end = parseTime(event.currentTarget.value); })} /></label>
                  </div>

                  <label class="field-label" for="transcript-editor">转写文本</label>
                  <textarea
                    id="transcript-editor"
                    ref={editorRef}
                    rows="7"
                    value={segment().text}
                    onSelect={(event) => {
                      const el = event.currentTarget;
                      if (el.selectionEnd > el.selectionStart) {
                        setSelRange({ start: el.selectionStart, end: el.selectionEnd });
                      } else {
                        setSelRange(null);
                      }
                    }}
                    onKeyUp={(event) => {
                      const el = event.currentTarget;
                      setSelRange(el.selectionEnd > el.selectionStart
                        ? { start: el.selectionStart, end: el.selectionEnd }
                        : null);
                    }}
                    onClick={(event) => {
                      const el = event.currentTarget;
                      setSelRange(el.selectionEnd > el.selectionStart
                        ? { start: el.selectionStart, end: el.selectionEnd }
                        : null);
                    }}
                    onChange={(event) => {
                      setSelRange(null);
                      editText(event.currentTarget.value);
                    }}
                  />
                  <Show when={markNotices()[segment().id]}>
                    <div class="mark-notice" role="alert">
                      <span>{markNotices()[segment().id]}</span>
                      <button onClick={() => dismissMarkNotice(segment().id)} aria-label="关闭提示">×</button>
                    </div>
                  </Show>
                  <div class="textarea-help">在文本里选中一个或几个字词，再点下方级别即可单独标记；光标拆分后词标记跟着原来的字走，整段重录则标记失效。</div>

                  <div class="field-label">
                    {selectedTokens().length
                      ? `选中词标记（${selectedTokens().map((word) => word.text).join("")}）`
                      : "整段基准置信度"}
                  </div>
                  <div class="confidence-picker" role="radiogroup" aria-label="置信度">
                    <For each={[1, 2, 3, 4, 5] as Confidence[]}>
                      {(value) => (
                        <button
                          class={`wc${value} ${!selectedTokens().length && segment().confidence === value ? "active" : ""}`}
                          title={selectedTokens().length
                            ? `把选中字词标为 ${value} 级`
                            : "没有选词时设置整段基准置信度"}
                          onClick={() => (selectedTokens().length ? markSelection(value) : setBaseConfidence(value))}
                        >
                          {value}
                        </button>
                      )}
                    </For>
                  </div>
                  <div class="confidence-summary">
                    <span class={`confidence c${effectiveConfidence(segment())}`}>综合 {effectiveConfidence(segment())}/5</span>
                    <Show when={minWordConfidence(segment()) !== null}>
                      <span class={`confidence c${minWordConfidence(segment()) ?? 3}`}>最低词 {minWordConfidence(segment())}/5</span>
                    </Show>
                    <span class="confidence-hint">综合值随词标记即时重算</span>
                  </div>

                  <div class="field-label">
                    词级标记
                    <Show when={normalizeMarks(segment().text, segment().wordMarks).length}>
                      <button class="inline-link" onClick={clearWordMarks}>全部清除</button>
                    </Show>
                  </div>
                  <Show
                    when={normalizeMarks(segment().text, segment().wordMarks).length}
                    fallback={<div class="mini-empty">还没有词级标记。在上面文本里选中听不准的字词即可单独标记。</div>}
                  >
                    <ul class="word-chip-list">
                      <For each={normalizeMarks(segment().text, segment().wordMarks)}>
                        {(mark) => (
                          <li class={`word-chip wc${mark.confidence}`}>
                            <span class="word-chip-text">{segment().text.slice(mark.start, mark.end)}</span>
                            <span class="word-chip-levels">
                              <For each={[1, 2, 3, 4, 5] as Confidence[]}>
                                {(value) => (
                                  <button
                                    class={mark.confidence === value ? "on" : ""}
                                    title={WORD_CONF_TITLES[value]}
                                    onClick={() => setWordMarkConfidence(mark, value)}
                                  >
                                    {value}
                                  </button>
                                )}
                              </For>
                            </span>
                            <button class="word-chip-remove" title="删除该标记" onClick={() => removeWordMark(mark)}>×</button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>

                  <div class="field-label">校对标记</div>
                  <div class="flag-list">
                    <div class="flag-row flag-derived">
                      <Checkbox checked={hasLowWord(segment())} disabled class="flag-row">
                        <Checkbox.Input />
                        <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                        <Checkbox.Label>低置信词（由 ≤2 级的词标记自动派生）</Checkbox.Label>
                      </Checkbox>
                    </div>
                    <Checkbox checked={segment().flags.dialect} onChange={() => toggleFlag("dialect")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>方言表达</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.properNoun} onChange={() => toggleFlag("properNoun")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>专有名词</Checkbox.Label>
                    </Checkbox>
                  </div>

                  <div class="split-actions">
                    <button onClick={splitSelection}>⌁ 按光标拆分</button>
                    <button disabled={activeTrack().segments.at(-1)?.id === segment().id} onClick={mergeWithNext}>合 合并下一段</button>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="align" class="tab-content align-content">
                  <AlignmentPanel
                    segment={segment()}
                    tracks={otherTracks()}
                  />
                </Tabs.Content>

                <Tabs.Content value="annotate" class="tab-content">
                  <div class="content-title"><h3>关联主题、事件与人物</h3><p>一个片段可关联多个实体，复核后颜色会显示在列表中。</p></div>
                  <For each={project().tags}>
                    {(tag) => (
                      <button class={`tag-option ${segment().tagIds.includes(tag.id) ? "selected" : ""}`} onClick={() => toggleTag(tag.id)}>
                        <i style={{ background: tag.color }} />
                        <span><strong>#{tag.label}</strong><small>{tag.type === "topic" ? "主题" : tag.type === "event" ? "事件" : "人物"}</small></span>
                        <b>{segment().tagIds.includes(tag.id) ? "✓" : "＋"}</b>
                      </button>
                    )}
                  </For>
                </Tabs.Content>

                <Tabs.Content value="comments" class="tab-content comments-content">
                  <div class="content-title"><h3>批注与回复</h3><p>批注不会改写原文，可保留校对依据并继续讨论。</p></div>
                  <div class="comment-compose">
                    <textarea rows="3" placeholder="记录读音、词义或专名依据…" value={commentDraft()} onInput={(event) => setCommentDraft(event.currentTarget.value)} />
                    <button class="btn btn-primary" onClick={addComment}>添加批注</button>
                  </div>
                  <For each={segment().comments} fallback={<div class="mini-empty">当前片段还没有批注。</div>}>
                    {(comment) => (
                      <article class={`comment-card ${comment.resolved ? "resolved" : ""}`}>
                        <header><strong>{comment.author}</strong><time>{new Date(comment.createdAt).toLocaleString()}</time></header>
                        <p>{comment.body}</p>
                        <For each={comment.replies}>
                          {(reply) => <div class="reply"><b>{reply.author}</b><span>{reply.body}</span></div>}
                        </For>
                        <div class="reply-row">
                          <input
                            value={replyDrafts()[comment.id] ?? ""}
                            placeholder="回复…"
                            onInput={(event) => setReplyDrafts((drafts) => ({ ...drafts, [comment.id]: event.currentTarget.value }))}
                            onKeyDown={(event) => { if (event.key === "Enter") addReply(comment.id); }}
                          />
                          <button onClick={() => addReply(comment.id)}>回复</button>
                        </div>
                        <button class="resolve-link" onClick={() => toggleComment(comment.id)}>{comment.resolved ? "重新打开" : "标记已解决"}</button>
                      </article>
                    )}
                  </For>
                </Tabs.Content>
              </Tabs>
            )}
          </Show>
        </aside>
      </div>

      <footer class="statusbar">
        <span>最近操作：{lastAction()}</span>
        <span>版本 {revision() + 1} · 本地草稿</span>
        <span class="status-shortcuts">J/K 浏览　R 已校对　M 合并　? 帮助</span>
      </footer>

      <Dialog open={helpOpen()} onOpenChange={setHelpOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content">
            <Dialog.Title>键盘校对</Dialog.Title>
            <Dialog.Description>光标在输入框中时，单键快捷键不会抢占文字输入。</Dialog.Description>
            <div class="shortcut-grid">
              <span><kbd>J</kbd><kbd>↓</kbd> 下一片段</span>
              <span><kbd>K</kbd><kbd>↑</kbd> 上一片段</span>
              <span><kbd>R</kbd> 标记已校对</span>
              <span><kbd>M</kbd> 合并下一片段</span>
              <span><kbd>Ctrl/⌘ Z</kbd> 撤销</span>
              <span><kbd>Ctrl/⌘ ⇧ Z</kbd> 重做</span>
              <span><kbd>Ctrl/⌘ S</kbd> 立即保存</span>
              <span><kbd>?</kbd> 显示本帮助</span>
            </div>
            <div class="dialog-footer"><button class="btn btn-primary" onClick={() => setHelpOpen(false)}>开始校对</button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  );
}
