/**
 * The ODA client: the only code that talks to Folketingets Åbne Data.
 * See `client.ts` for requests, paging and errors, `entities.ts` for the
 * typed queries, `download.ts` for files and `time.ts` for timestamps.
 */
export * from "@/lib/oda/client";
export * from "@/lib/oda/download";
export * from "@/lib/oda/entities";
export * from "@/lib/oda/time";
