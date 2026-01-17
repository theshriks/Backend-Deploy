#!/usr/bin/env node
/**
 * ShrikDB Phase 5 Performance - Benchmark CLI
 */

import * as fs from 'fs';
import { BenchmarkRunner } from './benchmarks/runner';
import { VerificationEngine } from './verification/engine';

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
        case 'benchmark':
        case 'bench':
            await runBenchmarks(args.slice(1));
            break;

        case 'verify':
            await runVerification(args.slice(1));
            break;

        case 'help':
        default:
            printHelp();
            break;
    }
}

async function runBenchmarks(args: string[]): Promise<void> {
    const outputFile = args.find(a => a.startsWith('--output='))?.split('=')[1];
    const dataDir = args.find(a => a.startsWith('--data-dir='))?.split('=')[1] || './data/benchmark';

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║    ShrikDB Phase 5 - Performance Benchmarks                ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`Data Directory: ${dataDir}`);
    console.log('');

    const runner = new BenchmarkRunner(dataDir);
    const results = await runner.runAll();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║    BENCHMARK RESULTS                                       ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    for (const result of results) {
        console.log(`${result.name}:`);
        console.log(`  Ops/sec:      ${result.opsPerSecond.toFixed(2)}`);
        console.log(`  Duration:     ${result.durationMs.toFixed(2)} ms`);
        console.log(`  Latency P50:  ${(result.latencyP50Micros / 1000).toFixed(2)} ms`);
        console.log(`  Latency P95:  ${(result.latencyP95Micros / 1000).toFixed(2)} ms`);
        console.log(`  Latency P99:  ${(result.latencyP99Micros / 1000).toFixed(2)} ms`);
        console.log(`  Fsync Count:  ${result.fsyncCount}`);
        console.log(`  Memory Used:  ${result.memoryUsedMB.toFixed(2)} MB`);
        console.log(`  Valid:        ${result.invariantsValid ? '✓ PASS' : '✗ FAIL'}`);
        if (result.errors.length > 0) {
            console.log(`  Errors:       ${result.errors.length}`);
        }
        console.log('');
    }

    // Check targets
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║    TARGET VERIFICATION                                     ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    const writeBatched = results.find(r => r.name.includes('batched'));
    const writeDurable = results.find(r => r.name.includes('durable'));
    const crud = results.find(r => r.name.includes('crud'));
    const query = results.find(r => r.name.includes('query'));
    const replay = results.find(r => r.name.includes('replay'));

    if (writeBatched) {
        const target = 50000;
        const passed = writeBatched.opsPerSecond >= target;
        console.log(`Write (batched):   ${passed ? '✓' : '✗'} ${writeBatched.opsPerSecond.toFixed(0)} ops/s (target: ≥${target})`);
    }

    if (writeDurable) {
        const target = 10000;
        const passed = writeDurable.opsPerSecond >= target;
        console.log(`Write (durable):   ${passed ? '✓' : '✗'} ${writeDurable.opsPerSecond.toFixed(0)} ops/s (target: ≥${target})`);
    }

    if (crud) {
        const target = 10000; // 10ms = 10000 µs
        const passed = crud.latencyP95Micros <= target;
        console.log(`CRUD round-trip:   ${passed ? '✓' : '✗'} ${(crud.latencyP95Micros / 1000).toFixed(2)} ms P95 (target: <10ms)`);
    }

    if (query) {
        const target = 5000; // 5ms = 5000 µs
        const passed = query.latencyP95Micros <= target;
        console.log(`Query filter:      ${passed ? '✓' : '✗'} ${(query.latencyP95Micros / 1000).toFixed(2)} ms P95 (target: <5ms)`);
    }

    if (replay) {
        const target = 100000;
        const passed = replay.opsPerSecond >= target;
        console.log(`Cold replay:       ${passed ? '✓' : '✗'} ${replay.opsPerSecond.toFixed(0)} events/s (target: ≥${target})`);
    }

    if (outputFile) {
        fs.writeFileSync(outputFile, JSON.stringify(results, (_, v) =>
            typeof v === 'bigint' ? v.toString() : v, 2));
        console.log(`\nResults saved to: ${outputFile}`);
    }
}

async function runVerification(args: string[]): Promise<void> {
    const dataDir = args.find(a => a.startsWith('--data-dir='))?.split('=')[1] || './data';

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║    ShrikDB Phase 5 - Verification Suite                    ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`Data Directory: ${dataDir}`);
    console.log('');

    const engine = new VerificationEngine(dataDir);
    const result = await engine.runFullVerification();

    process.exit(result.overallPassed ? 0 : 1);
}

function printHelp(): void {
    console.log(`
ShrikDB Phase 5 Performance CLI

Usage:
  npx ts-node cli.ts <command> [options]

Commands:
  benchmark, bench    Run performance benchmarks
  verify              Run verification suite
  help                Show this help

Options:
  --output=<file>     Save benchmark results to file
  --data-dir=<dir>    Data directory (default: ./data)

Examples:
  npx ts-node cli.ts benchmark --output=results.json
  npx ts-node cli.ts verify --data-dir=./data/wal
`);
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
