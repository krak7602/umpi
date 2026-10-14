export const MAX_VOICE_NOTE_SECONDS = 300;
export const MAX_VOICE_NOTE_BYTES = 8 * 1024 * 1024;
export const MAX_VOICE_TRANSCRIPT_LENGTH = 16_000;
export const MAX_TELEGRAM_INBOX_PENDING = 8;

export interface TelegramTextMessage {
  kind: "message";
  id: string;
  text: string;
  sentAt?: string;
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

export type TelegramInboxInput = TelegramTextMessage | TelegramVoiceNote;

export interface TelegramVoiceAudio {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface TelegramInboxDelivery {
  id: string;
  text: string;
  source: "text" | "voice";
  sentAt?: string;
  caption?: string;
}

export type VoiceNoteFailureCode =
  | "too_long" | "too_large" | "download_failed" | "authorization_missing"
  | "transcription_failed" | "speech_empty" | "transcript_too_long" | "interrupted";

/** Only fixed codes cross the private provider/Telegram transport boundary. */
export class VoiceNoteError extends Error {
  constructor(readonly code: VoiceNoteFailureCode) { super(code); }
}
