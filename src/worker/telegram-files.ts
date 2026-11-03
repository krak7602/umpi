import { MAX_FILE_BYTES, MAX_FILE_TEXT, VoiceNoteError, type TelegramDocument, type TelegramFileMessage } from "../shared/voice-note.js";
import type { TelegramConfig } from "./transport.js";
import { downloadTelegramFile } from "./telegram-voice.js";

/** The part of the Workers AI binding that converts documents to Markdown. Conversion of PDF and Word text is free. */
export interface DocumentConverter {
  toMarkdown(files: { name: string; blob: Blob }[], options?: unknown): Promise<({ format: string; data?: string; error?: string })[]>;
}

const CONVERTED = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

function kind(bytes: Uint8Array, name: string): keyof typeof CONVERTED | "text" {
  const starts = (values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts([0x25, 0x50, 0x44, 0x46])) return "pdf";
  // A Word document is a ZIP archive; other ZIP files are not read.
  if (starts([0x50, 0x4b, 0x03, 0x04])) return name.toLowerCase().endsWith(".docx") ? "docx" : (() => { throw new VoiceNoteError("file_unreadable"); })();
  return "text";
}

/** Plain text from bytes that must be valid UTF-8 without NUL characters. */
export function decodeText(bytes: Uint8Array): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new VoiceNoteError("file_unreadable"); }
  if (text.includes("\0")) throw new VoiceNoteError("file_unreadable");
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

export function documentFromText(name: string, raw: string): TelegramDocument {
  const text = raw.replace(/\n{4,}/g, "\n\n\n").trim();
  if (!text) throw new VoiceNoteError("file_unreadable");
  return { name, text: text.slice(0, MAX_FILE_TEXT), truncated: text.length > MAX_FILE_TEXT };
}

/** Downloads a document from Telegram and reads its text. Embedded images are not described, so no model runs. */
export async function readTelegramFile(file: TelegramFileMessage["file"], config: TelegramConfig, converter: DocumentConverter | undefined, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<TelegramDocument> {
  let bytes: Uint8Array;
  try { bytes = (await downloadTelegramFile(file, MAX_FILE_BYTES, config, signal, fetcher)).bytes; }
  catch (error) { throw new VoiceNoteError(error instanceof VoiceNoteError && error.code === "too_large" ? "file_too_large" : "file_unreadable"); }
  try { return await documentFromBytes(bytes, file.name, converter, signal); }
  finally { bytes.fill(0); }
}

/** A document's text from its bytes: text directly, PDF and Word through conversion. */
export async function documentFromBytes(bytes: Uint8Array, name: string, converter: DocumentConverter | undefined, signal?: AbortSignal): Promise<TelegramDocument> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new VoiceNoteError("file_too_large");
  try {
    const type = kind(bytes, name);
    if (type === "text") return documentFromText(name, decodeText(bytes));
    if (!converter) throw new VoiceNoteError("file_unreadable");
    signal?.throwIfAborted();
    const [result] = await converter.toMarkdown([{ name, blob: new Blob([bytes as BlobPart], { type: CONVERTED[type] }) }],
      { conversionOptions: type === "pdf" ? { pdf: { images: { convert: false }, metadata: false } } : { docx: { images: { convert: false } } } });
    if (!result || result.format === "error" || typeof result.data !== "string") throw new VoiceNoteError("file_unreadable");
    return documentFromText(name, result.data);
  } catch (error) {
    if (error instanceof VoiceNoteError) throw error;
    throw new VoiceNoteError("file_unreadable");
  }
}
