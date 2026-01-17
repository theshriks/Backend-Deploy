/**
 * Metrics Exporter - System metrics collection and export
 */

import {
    WALMetrics,
    ReplayMetrics,
    SnapshotMetrics,
    SystemMetrics,
    IMetricsExporter
} from '../contracts/types';
import { WALEngine } from '../wal/engine';
import { SnapshotEngine } from '../snapshot/engine';

interface MetricDefinition {
    name: string;
    type: 'counter' | 'gauge' | 'histogram';
    help: string;
    value: number;
    labels: Record<string, string>;
}

interface HistogramBucket {
    le: number;
    count: number;
}

export class MetricsExporter implements IMetricsExporter {
    private walEngine: WALEngine | null = null;
    private snapshotEngine: SnapshotEngine | null = null;
    private customMetrics: Map<string, MetricDefinition> = new Map();
    private histogramBuckets: Map<string, HistogramBucket[]> = new Map();

    private replayMetrics: ReplayMetrics = {
        eventsReplayed: 0n,
        replayDurationMs: 0,
        replayEventsPerSecond: 0,
        replayLag: 0n
    };

    setWALEngine(engine: WALEngine): void {
        this.walEngine = engine;
    }

    setSnapshotEngine(engine: SnapshotEngine): void {
        this.snapshotEngine = engine;
    }

    setReplayMetrics(metrics: ReplayMetrics): void {
        this.replayMetrics = metrics;
    }

    getMetrics(): SystemMetrics {
        const walMetrics: WALMetrics = this.walEngine?.getMetrics() ?? {
            totalEvents: 0n,
            totalBytesWritten: 0n,
            currentSegmentId: -1,
            sealedSegments: 0,
            writeLatencyP50: 0,
            writeLatencyP95: 0,
            writeLatencyP99: 0,
            eventsPerSecond: 0,
            bytesPerSecond: 0,
            batchQueueDepth: 0,
            backpressureActive: false
        };

        const snapshotMetrics: SnapshotMetrics = this.snapshotEngine?.getMetrics() ?? {
            totalSnapshots: 0,
            lastSnapshotSequence: 0n,
            lastSnapshotDurationMs: 0,
            totalSnapshotSizeBytes: 0n
        };

        return {
            wal: walMetrics,
            replay: this.replayMetrics,
            snapshot: snapshotMetrics,
            collectedAt: new Date().toISOString()
        };
    }

    exportPrometheus(): string {
        const metrics = this.getMetrics();
        const lines: string[] = [];

        // WAL metrics
        lines.push('# HELP shrikdb_wal_total_events Total events written to WAL');
        lines.push('# TYPE shrikdb_wal_total_events counter');
        lines.push(`shrikdb_wal_total_events ${metrics.wal.totalEvents}`);

        lines.push('# HELP shrikdb_wal_bytes_written Total bytes written to WAL');
        lines.push('# TYPE shrikdb_wal_bytes_written counter');
        lines.push(`shrikdb_wal_bytes_written ${metrics.wal.totalBytesWritten}`);

        lines.push('# HELP shrikdb_wal_current_segment Current segment ID');
        lines.push('# TYPE shrikdb_wal_current_segment gauge');
        lines.push(`shrikdb_wal_current_segment ${metrics.wal.currentSegmentId}`);

        lines.push('# HELP shrikdb_wal_sealed_segments Number of sealed segments');
        lines.push('# TYPE shrikdb_wal_sealed_segments gauge');
        lines.push(`shrikdb_wal_sealed_segments ${metrics.wal.sealedSegments}`);

        lines.push('# HELP shrikdb_wal_write_latency_p50 Write latency P50 in microseconds');
        lines.push('# TYPE shrikdb_wal_write_latency_p50 gauge');
        lines.push(`shrikdb_wal_write_latency_p50 ${metrics.wal.writeLatencyP50}`);

        lines.push('# HELP shrikdb_wal_write_latency_p95 Write latency P95 in microseconds');
        lines.push('# TYPE shrikdb_wal_write_latency_p95 gauge');
        lines.push(`shrikdb_wal_write_latency_p95 ${metrics.wal.writeLatencyP95}`);

        lines.push('# HELP shrikdb_wal_write_latency_p99 Write latency P99 in microseconds');
        lines.push('# TYPE shrikdb_wal_write_latency_p99 gauge');
        lines.push(`shrikdb_wal_write_latency_p99 ${metrics.wal.writeLatencyP99}`);

        lines.push('# HELP shrikdb_wal_events_per_second Events per second');
        lines.push('# TYPE shrikdb_wal_events_per_second gauge');
        lines.push(`shrikdb_wal_events_per_second ${metrics.wal.eventsPerSecond.toFixed(2)}`);

        lines.push('# HELP shrikdb_wal_batch_queue_depth Batch queue depth');
        lines.push('# TYPE shrikdb_wal_batch_queue_depth gauge');
        lines.push(`shrikdb_wal_batch_queue_depth ${metrics.wal.batchQueueDepth}`);

        lines.push('# HELP shrikdb_wal_backpressure Backpressure active (1=yes, 0=no)');
        lines.push('# TYPE shrikdb_wal_backpressure gauge');
        lines.push(`shrikdb_wal_backpressure ${metrics.wal.backpressureActive ? 1 : 0}`);

        // Replay metrics
        lines.push('# HELP shrikdb_replay_events_total Events replayed');
        lines.push('# TYPE shrikdb_replay_events_total counter');
        lines.push(`shrikdb_replay_events_total ${metrics.replay.eventsReplayed}`);

        lines.push('# HELP shrikdb_replay_lag_events Replay lag in events');
        lines.push('# TYPE shrikdb_replay_lag_events gauge');
        lines.push(`shrikdb_replay_lag_events ${metrics.replay.replayLag}`);

        // Snapshot metrics
        lines.push('# HELP shrikdb_snapshot_total Total snapshots created');
        lines.push('# TYPE shrikdb_snapshot_total counter');
        lines.push(`shrikdb_snapshot_total ${metrics.snapshot.totalSnapshots}`);

        lines.push('# HELP shrikdb_snapshot_size_bytes Total snapshot size in bytes');
        lines.push('# TYPE shrikdb_snapshot_size_bytes gauge');
        lines.push(`shrikdb_snapshot_size_bytes ${metrics.snapshot.totalSnapshotSizeBytes}`);

        // Custom metrics
        for (const metric of this.customMetrics.values()) {
            const labelStr = Object.entries(metric.labels)
                .map(([k, v]) => `${k}="${v}"`)
                .join(',');
            const labelPart = labelStr ? `{${labelStr}}` : '';

            lines.push(`# HELP ${metric.name} ${metric.help}`);
            lines.push(`# TYPE ${metric.name} ${metric.type}`);
            lines.push(`${metric.name}${labelPart} ${metric.value}`);
        }

        return lines.join('\n');
    }

    exportJSON(): string {
        return JSON.stringify(this.getMetrics(), (_, v) =>
            typeof v === 'bigint' ? v.toString() : v, 2);
    }

    registerMetric(name: string, type: 'counter' | 'gauge' | 'histogram', help: string): void {
        this.customMetrics.set(name, { name, type, help, value: 0, labels: {} });
        if (type === 'histogram') {
            this.histogramBuckets.set(name, [
                { le: 10, count: 0 }, { le: 50, count: 0 }, { le: 100, count: 0 },
                { le: 500, count: 0 }, { le: 1000, count: 0 }, { le: 5000, count: 0 }
            ]);
        }
    }

    incrementCounter(name: string, value = 1, labels: Record<string, string> = {}): void {
        const metric = this.customMetrics.get(name);
        if (metric && metric.type === 'counter') {
            metric.value += value;
            metric.labels = { ...metric.labels, ...labels };
        }
    }

    setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
        const metric = this.customMetrics.get(name);
        if (metric && metric.type === 'gauge') {
            metric.value = value;
            metric.labels = { ...metric.labels, ...labels };
        }
    }

    observeHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
        const buckets = this.histogramBuckets.get(name);
        if (buckets) {
            for (const bucket of buckets) {
                if (value <= bucket.le) bucket.count++;
            }
        }
    }
}
