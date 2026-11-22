/**
 * Housekeeping of the built-in archive (hourly): purge the trash after the retention of each
 * library, apply version retention, collect unreferenced blobs, verify a slice of the blobs,
 * keep SQLite's query planner statistics fresh and run a weekly integrity check.
 */
import type { LocalBackend } from './backend.js';
import { logger } from '../logger.js';
import { describeError } from '../util/http.js';
import { checkCounters, rebuildCounters } from './counters.js';

const log = logger.child({ module: 'archive' });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Blobs verified per run (spreads a full verification over about a month of hourly runs). */
const VERIFY_PER_RUN = 50;

export interface MaintenanceReport {
  purged: number;
  versionsRemoved: number;
  blobsRemoved: number;
  orphanFiles: number;
  verified: number;
  corrupt: string[];
  quickCheck: string | null;
  /** Counter entries that differed from a recount (rebuilt then). */
  countersRepaired: number;
}

export class ArchiveMaintenance {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<MaintenanceReport> | null = null;

  constructor(
    private readonly backend: LocalBackend,
    scheduled = true,
  ) {
    // First run a few minutes after the start, then hourly. Timers never keep the process alive.
    if (!scheduled) return;
    this.timer = setTimeout(() => this.tick(), 5 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private tick(): void {
    void this.run().finally(() => {
      if (this.timer === null) return;
      this.timer = setTimeout(() => this.tick(), HOUR);
      this.timer.unref();
    });
  }

  private get db() {
    return this.backend.ctx.db;
  }

  run(): Promise<MaintenanceReport> {
    this.running ??= this.doRun().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doRun(): Promise<MaintenanceReport> {
    const report: MaintenanceReport = { purged: 0, versionsRemoved: 0, blobsRemoved: 0, orphanFiles: 0, verified: 0, corrupt: [], quickCheck: null, countersRepaired: 0 };
    try {
      report.purged = this.purgeTrash();
      report.versionsRemoved = this.applyVersionRetention();
      report.blobsRemoved = await this.collectBlobs();
      report.orphanFiles = (await this.backend.blobs.gc((sha) => Boolean(this.db.prepare('SELECT 1 FROM blobs WHERE sha256 = ?').get(sha)))).orphans;
      const verify = await this.verifySome();
      report.verified = verify.verified;
      report.corrupt = verify.corrupt;
      this.db.pragma('optimize');
      this.db.pragma('incremental_vacuum(2000)');
      const kv = this.backend.ctx.repos.kv;
      if (Date.now() - (kv.get<number>('archive.quick_check_at') ?? 0) > 7 * DAY) {
        const res = this.db.pragma('quick_check', { simple: true }) as string;
        kv.set('archive.quick_check_at', Date.now());
        kv.set('archive.quick_check', res);
        report.quickCheck = res;
        if (res !== 'ok') log.error(`Database integrity check failed: ${res}`);
        // The counters are kept by triggers; a recount catches anything that slipped past them.
        report.countersRepaired = checkCounters(this.db);
        if (report.countersRepaired) {
          log.warn(`${report.countersRepaired} document counters differed from a recount – rebuilt`);
          rebuildCounters(this.db);
        }
      }
    } catch (err) {
      log.error(`Archive maintenance failed: ${describeError(err)}`);
    }
    if (report.purged || report.versionsRemoved || report.blobsRemoved || report.corrupt.length) log.info({ report }, 'Archive maintenance finished');
    return report;
  }

  /** Documents longer in the trash than their library keeps them. */
  purgeTrash(now = Date.now()): number {
    const defaultDays = this.backend.ctx.cfg.archive.builtin.trashDays;
    let purged = 0;
    for (const lib of this.backend.ctx.repos.libraries.list(true)) {
      const days = lib.settings.trashDays ?? defaultDays;
      const rows = this.db.prepare('SELECT * FROM lib_documents WHERE library_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?').all(lib.id, now - days * DAY) as Parameters<
        LocalBackend['purgeRow']
      >[0][];
      for (const row of rows) {
        this.backend.purgeRow(row, { actor: 'system', ref: 'trash-retention' });
        this.backend.ctx.events.emit({ type: 'document.purged', id: row.id, libraryId: row.library_id });
        purged++;
      }
    }
    if (purged) log.info(`Emptied the trash: ${purged} document(s) deleted for good`);
    return purged;
  }

  /** Versions beyond the library's limits (never the current version or version 1). */
  applyVersionRetention(now = Date.now()): number {
    let removed = 0;
    for (const lib of this.backend.ctx.repos.libraries.list()) {
      const { maxVersions, maxVersionAgeDays } = lib.settings;
      if (!maxVersions && !maxVersionAgeDays) continue;
      const docs = this.db
        .prepare('SELECT d.id, d.current_version, d.library_id FROM lib_documents d WHERE d.library_id = ? AND (SELECT COUNT(DISTINCT version) FROM lib_document_files f WHERE f.document_id = d.id) > 1')
        .all(lib.id) as { id: number; current_version: number; library_id: number }[];
      for (const d of docs) {
        const versions = this.db.prepare('SELECT version, MIN(created_at) AS created_at FROM lib_document_files WHERE document_id = ? GROUP BY version ORDER BY version DESC').all(d.id) as {
          version: number;
          created_at: number;
        }[];
        const keep = new Set<number>([d.current_version, 1]);
        const drop = versions.filter((v, i) => !keep.has(v.version) && ((maxVersions && i >= maxVersions) || (maxVersionAgeDays && now - v.created_at > maxVersionAgeDays * DAY)));
        for (const v of drop) {
          this.backend.removeVersion(d, v.version, { actor: 'system', ref: 'version-retention' });
          removed++;
        }
      }
    }
    return removed;
  }

  /** Blob rows no file row references any more: delete the file, then the row. */
  async collectBlobs(): Promise<number> {
    const rows = this.db.prepare('SELECT sha256 FROM blobs WHERE NOT EXISTS (SELECT 1 FROM lib_document_files f WHERE f.blob_sha256 = blobs.sha256)').all() as { sha256: string }[];
    for (const r of rows) {
      await this.backend.blobs.remove(r.sha256);
      this.db.prepare('DELETE FROM blobs WHERE sha256 = ? AND NOT EXISTS (SELECT 1 FROM lib_document_files f WHERE f.blob_sha256 = ?)').run(r.sha256, r.sha256);
    }
    return rows.length;
  }

  /** Recompute the checksums of the least recently verified blobs. */
  async verifySome(limit = VERIFY_PER_RUN): Promise<{ verified: number; corrupt: string[] }> {
    const rows = this.db.prepare('SELECT sha256 FROM blobs ORDER BY COALESCE(verified_at, 0), created_at LIMIT ?').all(limit) as { sha256: string }[];
    const corrupt: string[] = [];
    for (const r of rows) {
      if (await this.backend.blobs.verify(r.sha256)) this.db.prepare('UPDATE blobs SET verified_at = ? WHERE sha256 = ?').run(Date.now(), r.sha256);
      else corrupt.push(r.sha256);
    }
    if (corrupt.length) {
      log.error(`${corrupt.length} file(s) of the archive are missing or damaged: ${corrupt.slice(0, 5).join(', ')}${corrupt.length > 5 ? ' …' : ''} – restore them from the backup`);
      this.backend.ctx.repos.kv.set('archive.corrupt_blobs', corrupt);
    }
    return { verified: rows.length - corrupt.length, corrupt };
  }
}
