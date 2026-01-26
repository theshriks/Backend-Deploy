/**
 * ShrikDB Phase 6.2 - Truth Bridge CLI
 * 
 * Command-line interface for managing the Truth Bridge.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TruthBridge } from './bridge/truth-bridge';
import { IWALTarget } from './bridge/batch-forwarder';
import { VelocityEvent } from './contracts/types';
import { runVerificationSuite } from './verification/run-verification';

// Import Phase 5 WAL if available
let UltraFastWAL: any = null;
try {
    // Try to import from Phase 5
    const phase5Path = path.resolve(__dirname, '../ShrikDbb/shrikdb-phase5-performance/wal/ultra-fast');
    if (fs.existsSync(phase5Path + '.ts') || fs.existsSync(phase5Path + '.js')) {
        UltraFastWAL = require(phase5Path).UltraFastWAL;
    }
} catch (e) {
    // Phase 5 not available, will use mock for testing
}

// Simple mock WAL for standalone testing
class MockWAL implements IWALTarget {
    private headSequence = 0n;
    private events: any[] = [];
    private dataDir: string;

    constructor(dataDir: string) {
        this.dataDir = dataDir;
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
    }

    async initialize(): Promise<void> {
        // Load existing events if any
        const eventsPath = path.join(this.dataDir, 'events.json');
        if (fs.existsSync(eventsPath)) {
            const data = JSON.parse(fs.readFileSync(eventsPath, 'utf-8'));
            this.events = data.events || [];
            this.headSequence = BigInt(data.headSequence || 0);
        }
    }

    async append(input: {
        tenantId: string;
        eventType: string;
        payload: Record<string, unknown>;
    }): Promise<{ sequence: bigint; latencyMicros: number }> {
        this.headSequence++;
        this.events.push({
            sequence: this.headSequence.toString(),
            tenantId: input.tenantId,
            eventType: input.eventType,
            payload: input.payload,
            timestamp: Date.now()
        });

        // Persist
        const eventsPath = path.join(this.dataDir, 'events.json');
        fs.writeFileSync(eventsPath, JSON.stringify({
            headSequence: this.headSequence.toString(),
            events: this.events
        }, null, 2));

        return {
            sequence: this.headSequence,
            latencyMicros: Math.round(Math.random() * 500 + 100)
        };
    }

    getHeadSequence(): bigint {
        return this.headSequence;
    }

    async shutdown(): Promise<void> {
        // Already persisted on each append
    }

    getEvents() {
        return this.events;
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args[0];

    const bridgeDataDir = './data/bridge';
    const walDataDir = './data/wal';

    switch (command) {
        case 'verify':
        case 'test':
            await runVerificationSuite();
            break;

        case 'start':
            console.log('Starting Truth Bridge...');

            let wal: IWALTarget;
            if (UltraFastWAL) {
                console.log('Using Phase 5 UltraFastWAL');
                wal = new UltraFastWAL({ dataDir: walDataDir });
                await (wal as any).initialize();
            } else {
                console.log('Using MockWAL (Phase 5 not found)');
                wal = new MockWAL(walDataDir);
                await (wal as any).initialize();
            }

            const bridge = new TruthBridge(wal, {
                dataDir: bridgeDataDir,
                walDataDir
            });

            const recovery = await bridge.initialize();
            if (recovery) {
                console.log(`Recovery completed: ${recovery.pendingEvents} pending, ${recovery.redelivered} redelivered`);
            }

            console.log('Bridge ready. Press Ctrl+C to stop.');

            // Simple demo: send test events
            if (args.includes('--demo')) {
                console.log('\nRunning demo...');
                for (let i = 1; i <= 10; i++) {
                    const event: VelocityEvent = {
                        velocitySeq: BigInt(i),
                        streamId: 'demo-stream',
                        tenantId: 'demo-tenant',
                        eventType: 'demo.event',
                        payload: { id: i, message: `Demo event ${i}` },
                        irreversibilityMarker: true,
                        timestamp: Date.now() * 1000
                    };

                    try {
                        const receipt = await bridge.accept(event);
                        console.log(`  Event ${i} -> WAL seq ${receipt.walSequence}`);
                    } catch (error) {
                        console.log(`  Event ${i} failed: ${(error as Error).message}`);
                    }
                }

                const metrics = bridge.getMetrics();
                console.log('\nMetrics:');
                console.log(`  Received: ${metrics.totalReceived}`);
                console.log(`  Delivered: ${metrics.totalDelivered}`);
                console.log(`  Duplicates: ${metrics.totalDuplicates}`);
                console.log(`  Rejected: ${metrics.totalRejected}`);
            }

            // Keep running
            await new Promise<void>((resolve) => {
                process.on('SIGINT', async () => {
                    console.log('\nShutting down...');
                    await bridge.shutdown();
                    if ((wal as any).shutdown) {
                        await (wal as any).shutdown();
                    }
                    console.log('Shutdown complete.');
                    resolve();
                });
            });
            break;

        case 'send-test':
            const count = parseInt(args[1] || '100', 10);
            console.log(`Sending ${count} test events...`);

            const testWal = new MockWAL(walDataDir);
            await testWal.initialize();

            const testBridge = new TruthBridge(testWal, {
                dataDir: bridgeDataDir,
                walDataDir
            });
            await testBridge.initialize();

            const startTime = Date.now();
            for (let i = 1; i <= count; i++) {
                const event: VelocityEvent = {
                    velocitySeq: BigInt(i),
                    streamId: `test-stream-${i % 5}`,
                    tenantId: 'test-tenant',
                    eventType: 'test.event',
                    payload: { id: i, data: `Event ${i}` },
                    irreversibilityMarker: true,
                    timestamp: Date.now() * 1000
                };

                await testBridge.accept(event);

                if (i % 100 === 0) {
                    console.log(`  Sent ${i}/${count}`);
                }
            }

            await testBridge.shutdown();

            const duration = Date.now() - startTime;
            console.log(`\nCompleted: ${count} events in ${duration}ms (${Math.round(count / (duration / 1000))} events/sec)`);
            break;

        case 'status':
            console.log('Checking bridge status...');

            if (!fs.existsSync(bridgeDataDir)) {
                console.log('Bridge data directory not found. Bridge has not been initialized.');
                break;
            }

            const idempotencyLog = path.join(bridgeDataDir, 'idempotency.log');
            const bufferWal = path.join(bridgeDataDir, 'buffer.wal');

            console.log('\nBridge Status:');
            console.log(`  Data directory: ${bridgeDataDir}`);

            if (fs.existsSync(idempotencyLog)) {
                const stats = fs.statSync(idempotencyLog);
                console.log(`  Idempotency log: ${stats.size} bytes`);
            } else {
                console.log('  Idempotency log: not found');
            }

            if (fs.existsSync(bufferWal)) {
                const stats = fs.statSync(bufferWal);
                console.log(`  Buffer WAL: ${stats.size} bytes`);
            } else {
                console.log('  Buffer WAL: not found');
            }
            break;

        case 'dump-wal':
            const limit = parseInt(args[1] || '10', 10);
            console.log(`Dumping last ${limit} events from WAL...\n`);

            const dumpWal = new MockWAL(walDataDir);
            await dumpWal.initialize();

            const allEvents = dumpWal.getEvents();
            const displayEvents = allEvents.slice(-limit);

            for (const event of displayEvents) {
                console.log(`Seq ${event.sequence}:`);
                console.log(`  Tenant: ${event.tenantId}`);
                console.log(`  Type: ${event.eventType}`);
                console.log(`  Payload: ${JSON.stringify(event.payload)}`);
                console.log('');
            }

            console.log(`Total events in WAL: ${allEvents.length}`);
            break;

        case 'help':
        default:
            console.log('ShrikDB Phase 6.2 - Truth Bridge CLI\n');
            console.log('Usage: npx ts-node cli.ts <command> [options]\n');
            console.log('Commands:');
            console.log('  start [--demo]    Start the Truth Bridge (with optional demo)');
            console.log('  verify            Run the verification suite');
            console.log('  test              Alias for verify');
            console.log('  send-test [N]     Send N test events (default: 100)');
            console.log('  status            Show bridge status');
            console.log('  dump-wal [N]      Dump last N events from WAL (default: 10)');
            console.log('  help              Show this help message');
            break;
    }
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
