import { syncBrowserSnapshots, type BrowserExportConfig } from "./browser-export.js";

/**
 * The browser login exporter as an executor lane. Each run is the exporter's own scheduled sync: it reads
 * newly approved snapshot requests and exports only sites whose six-hour attempt is due, with the
 * exporter's separate browser-sync credential, helper and state. A run never blocks the other lanes.
 */
export const EXPORT_CHECK_MS = 5 * 60_000;

export class BrowserExportLane {
  private running: Promise<void> | undefined;
  private lastRun = -Infinity;
  private woken = true;

  constructor(private readonly config: BrowserExportConfig, private readonly options: {
    emit(event: string): void;
    sync?: typeof syncBrowserSnapshots;
    now?(): number;
  }) {}

  /** A coordinator wake can mean a newly approved snapshot request. */
  wake(): void { this.woken = true; }
  get busy(): boolean { return this.running !== undefined; }

  /** Starts a sync when due. Overlapping runs are skipped; the exporter also holds its own state lease. */
  tick(signal: AbortSignal): void {
    if (this.running || signal.aborted) return;
    const now = this.options.now?.() ?? Date.now();
    if (!this.woken && now - this.lastRun < EXPORT_CHECK_MS) return;
    this.woken = false; this.lastRun = now;
    let exported = 0;
    this.running = (this.options.sync ?? syncBrowserSnapshots)(this.config, { signal, output: () => { exported++; } }, true)
      .then(() => { if (exported) this.options.emit(`browser_snapshots_exported ${exported}`); },
        () => { if (!signal.aborted) this.options.emit("browser_export_failed"); })
      .finally(() => { this.running = undefined; });
  }

  async idle(): Promise<void> { await this.running; }
}
