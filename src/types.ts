export type Confidence = 1 | 2 | 3 | 4 | 5;

/**
 * 词级置信标记：锚定在片段正文 text 的 [start, end) 字符偏移上。
 * 标记随“原来那几个字”迁移，而不是随位置迁移。
 */
export interface WordMark {
  start: number;
  end: number;
  confidence: Confidence;
}

/** 旧稿（schema 1）按原整段级别回填到词时，回填失败片段的说明。 */
export interface BackfillNote {
  id: string;
  segmentId: string;
  trackId: string;
  trackName: string;
  preview: string;
  reason: string;
  createdAt: string;
}

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

export interface Segment {
  id: string;
  start: number;
  end: number;
  speakerId: string;
  text: string;
  /** 无词级标记时的整段基准置信度（旧稿回填也以它为来源）。 */
  confidence: Confidence;
  reviewed: boolean;
  flags: {
    /** 由词级标记自动派生：存在置信度 ≤2 的词即视为低置信。 */
    lowConfidence: boolean;
    dialect: boolean;
    properNoun: boolean;
  };
  /** 词级置信标记；旧片段或导入片段可能没有该字段。 */
  wordMarks?: WordMark[];
  tagIds: string[];
  comments: ReviewComment[];
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
  backfillNotes?: BackfillNote[];
  updatedAt: string;
}

export interface PersistedEnvelope {
  schema: 2;
  revision: number;
  tabId: string;
  savedAt: number;
  project: ProjectData;
}
