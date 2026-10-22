export const MAX_VOICE_NOTE_SECONDS = 300;
export const MAX_VOICE_NOTE_BYTES = 8 * 1024 * 1024;
export const MAX_VOICE_TRANSCRIPT_LENGTH = 16_000;
export const MAX_TELEGRAM_INBOX_PENDING = 8;
/** Images per owner message, combined. A stored Pi entry stays well below the 2 MB SQLite row limit. */
export const MAX_IMAGE_BYTES = 1_048_576;
export const MAX_IMAGES_PER_MESSAGE = 4;
/** Longest image side to request from Telegram's sizes; the model scales larger images down anyway. */
export const MAX_IMAGE_SIDE = 2_000;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

export interface TelegramTextMessage {
  kind: "message";
  id: string;
  text: string;
  sentAt?: string;
  /** An attachment that was skipped, such as "a video"; the text is its caption. */
  skipped?: string;
}

export interface TelegramVoiceNote {
  kind: "voice";
  id: string;
  messageId: number;
  fileId: string;
  fileUniqueId: string;
  duration: number;
  fileSize?: number;
  mimeType?: string;
  caption?: string;
  sentAt: string;
}

export interface TelegramFile {
  fileId: string;
  fileUniqueId: string;
  fileSize?: number;
}

export interface TelegramImageMessage {
  kind: "image";
  id: string;
  messageId: number;
  image: TelegramFile & { mimeType?: string };
  caption?: string;
  sentAt: string;
  /** Telegram album identity. Images of one album become one owner message. */
  mediaGroupId?: string;
}

/** A message with nothing Umpi can act on, such as a video without a caption. */
export interface TelegramUnreadableMessage {
  kind: "unreadable";
  id: string;
  attachment: string;
  sentAt?: string;
}

export type TelegramInboxInput = TelegramTextMessage | TelegramVoiceNote | TelegramImageMessage | TelegramUnreadableMessage;

export interface TelegramImage {
  data: string;
  mimeType: (typeof IMAGE_TYPES)[number];
}

export interface TelegramVoiceAudio {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface TelegramInboxDelivery {
  id: string;
  text: string;
  source: "text" | "voice" | "image";
  sentAt?: string;
  caption?: string;
  skipped?: string;
  images?: TelegramImage[];
  /** Album images left out because the combined size limit was reached. */
  omittedImages?: number;
}

export type VoiceNoteFailureCode =
  | "too_long" | "too_large" | "download_failed" | "authorization_missing"
  | "transcription_failed" | "speech_empty" | "transcript_too_long" | "interrupted"
  | "image_too_large" | "image_download_failed" | "image_not_delivered" | "unreadable";

/** Only fixed codes cross the private provider/Telegram transport boundary. */
export class VoiceNoteError extends Error {
  constructor(readonly code: VoiceNoteFailureCode) { super(code); }
}
