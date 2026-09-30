export type Confidence = 1 | 2 | 3 | 4 | 5;

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export interface Speaker {
  id: string;
  name: string;
  role: string;
  color: string;
}

export interface Tag {
  id: string;
  label: string;
  type: "topic" | "event" | "person";
  color: string;
}

export interface WordMark {
  id: string;
  /** 字符偏移起点（含），相对于片段 text */
  start: number;
  /** 字符偏移终点（不含） */
  end: number;
  /** 标记覆盖的原文，作为内容锚点；文字改动后按此重定位，而不是死贴偏移 */
  text: string;
  confidence: Confidence;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  speakerId: string;
  text: string;
  confidence: Confidence;
  reviewed: boolean;
  flags: {
    lowConfidence: boolean;
    dialect: boolean;
    properNoun: boolean;
  };
  tagIds: string[];
  comments: ReviewComment[];
  /**
   * 词级置信标记。
   * - 存在（数组可能为空）：已迁移到词级，整段置信度由标记派生（取最小值）。
   * - 缺省（undefined）：旧稿片段，尚未回填，沿用整段置信度。
   */
  words?: WordMark[];
  /** 整段文字被重新转录后，丢失内容锚点、等待重新标记的词级标记。 */
  staleMarks?: WordMark[];
}

export interface TranscriptTrack {
  id: string;
  name: string;
  language: string;
  status: "待校对" | "校对中" | "已完成";
  segments: Segment[];
}

export interface ProjectData {
  id: string;
  title: string;
  interviewee: string;
  recordingDate: string;
  activeTrackId: string;
  speakers: Speaker[];
  tags: Tag[];
  tracks: TranscriptTrack[];
  updatedAt: string;
}

export interface PersistedEnvelope {
  schema: 1 | 2;
  revision: number;
  tabId: string;
  savedAt: number;
  project: ProjectData;
}
