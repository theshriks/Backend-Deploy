/**
 * WAL Segment Management
 * Fixed-size segments with rotation, sealing, and checksum verification
 */

import * as fs from 'fs';
import * as path from 'path';
import { WALEvent, WALSegment, WALConfig } from '../contracts/types';
import { crc32, combineCrc32 } from './crc32';

const SEGMENT_HEADER_SIZE = 64; // bytes
const EVENT_HEADER_SIZE = 32; // bytes
const MAGIC_NUMBER = 0x5348524B; // "SHRK" in hex

/**
 * Segment Header Structure (64 bytes):
 * - Magic number (4 bytes)
 * - Version (4 bytes)
 * - Segment ID (8 bytes)
 * - Start sequence (8 bytes)
 * - End sequence (8 bytes) - 0 if not sealed
 * - Event count (8 bytes)
 * - Created timestamp (8 bytes)
 * - Sealed timestamp (8 bytes) - 0 if not sealed
 * - Checksum (4 bytes)
 * - Reserved (4 bytes)
 */

/**
 * Event Header Structure (32 bytes):
 * - Sequence (8 bytes)
 * - Timestamp (8 bytes) - Unix timestamp in microseconds
 * - Payload length (4 bytes)
 * - Tenant ID length (2 bytes)
 * - Event type length (2 bytes)
 * - Checksum (4 bytes)
 * - Reserved (4 bytes)
 */

export interface SegmentWriter {
    segmentId: number;
    filePath: string;
    fd: number;
    currentOffset: number;
    eventCount: number;
    startSequence: bigint;
    lastSequence: bigint;
    eventChecksums: number[];
    createdAt: Date;
}

export interface SegmentReader {
    segment: WALSegment;
    fd: number;
    currentOffset: number;
}

/**
 * Create a new segment file
 */
export function createSegment(
    dataDir: string,
    segmentId: number,
    startSequence: bigint
): SegmentWriter {
    const fileName = `wal_${String(segmentId).padStart(10, '0')}.seg`;
    const filePath = path.join(dataDir, fileName);

    // Ensure directory exists
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    // Create and open file
    const fd = fs.openSync(filePath, 'w+');

    const writer: SegmentWriter = {
        segmentId,
        filePath,
        fd,
        currentOffset: SEGMENT_HEADER_SIZE,
        eventCount: 0,
        startSequence,
        lastSequence: startSequence - 1n,
        eventChecksums: [],
        createdAt: new Date()
    };

    // Write initial header
    writeSegmentHeader(writer, null);

    return writer;
}

/**
 * Write segment header
 */
function writeSegmentHeader(writer: SegmentWriter, sealedAt: Date | null): void {
    const header = Buffer.alloc(SEGMENT_HEADER_SIZE);
    let offset = 0;

    // Magic number
    header.writeUInt32LE(MAGIC_NUMBER, offset);
    offset += 4;

    // Version
    header.writeUInt32LE(1, offset);
    offset += 4;

    // Segment ID
    header.writeBigInt64LE(BigInt(writer.segmentId), offset);
    offset += 8;

    // Start sequence
    header.writeBigInt64LE(writer.startSequence, offset);
    offset += 8;

    // End sequence (0 if not sealed)
    header.writeBigInt64LE(sealedAt ? writer.lastSequence : 0n, offset);
    offset += 8;

    // Event count
    header.writeBigInt64LE(BigInt(writer.eventCount), offset);
    offset += 8;

    // Created timestamp (milliseconds)
    header.writeBigInt64LE(BigInt(writer.createdAt.getTime()), offset);
    offset += 8;

    // Sealed timestamp (0 if not sealed)
    header.writeBigInt64LE(BigInt(sealedAt ? sealedAt.getTime() : 0), offset);
    offset += 8;

    // Checksum of header (excluding checksum field itself)
    const headerWithoutChecksum = header.subarray(0, offset);
    const checksum = crc32(headerWithoutChecksum);
    header.writeUInt32LE(checksum, offset);
    offset += 4;

    // Reserved
    header.writeUInt32LE(0, offset);

    // Write header at beginning of file
    fs.writeSync(writer.fd, header, 0, SEGMENT_HEADER_SIZE, 0);
}

/**
 * Write an event to the segment
 * Returns the byte offset where event was written
 */
export function writeEvent(
    writer: SegmentWriter,
    event: WALEvent
): { offset: number; bytesWritten: number } {
    const tenantIdBuffer = Buffer.from(event.tenantId, 'utf-8');
    const eventTypeBuffer = Buffer.from(event.eventType, 'utf-8');
    const payloadBuffer = Buffer.from(JSON.stringify(event.payload), 'utf-8');

    const totalPayloadSize = tenantIdBuffer.length + eventTypeBuffer.length + payloadBuffer.length;
    const totalEventSize = EVENT_HEADER_SIZE + totalPayloadSize;

    // Create event buffer
    const eventBuffer = Buffer.alloc(totalEventSize);
    let offset = 0;

    // Sequence
    eventBuffer.writeBigInt64LE(event.sequence, offset);
    offset += 8;

    // Timestamp (store as microseconds since epoch)
    const timestampMicros = BigInt(new Date(event.timestamp).getTime()) * 1000n;
    eventBuffer.writeBigInt64LE(timestampMicros, offset);
    offset += 8;

    // Payload length
    eventBuffer.writeUInt32LE(payloadBuffer.length, offset);
    offset += 4;

    // Tenant ID length
    eventBuffer.writeUInt16LE(tenantIdBuffer.length, offset);
    offset += 2;

    // Event type length
    eventBuffer.writeUInt16LE(eventTypeBuffer.length, offset);
    offset += 2;

    // Checksum placeholder
    const checksumOffset = offset;
    offset += 4;

    // Reserved
    eventBuffer.writeUInt32LE(0, offset);
    offset += 4;

    // Copy tenant ID, event type, and payload
    tenantIdBuffer.copy(eventBuffer, offset);
    offset += tenantIdBuffer.length;

    eventTypeBuffer.copy(eventBuffer, offset);
    offset += eventTypeBuffer.length;

    payloadBuffer.copy(eventBuffer, offset);

    // Calculate checksum of event data (excluding checksum field)
    const dataToChecksum = Buffer.concat([
        eventBuffer.subarray(0, checksumOffset),
        eventBuffer.subarray(checksumOffset + 4)
    ]);
    const checksum = crc32(dataToChecksum);
    eventBuffer.writeUInt32LE(checksum, checksumOffset);

    // Write to file
    const writeOffset = writer.currentOffset;
    fs.writeSync(writer.fd, eventBuffer, 0, eventBuffer.length, writeOffset);

    // Update writer state
    writer.currentOffset += totalEventSize;
    writer.eventCount++;
    writer.lastSequence = event.sequence;
    writer.eventChecksums.push(checksum);

    return { offset: writeOffset, bytesWritten: totalEventSize };
}

/**
 * Sync segment to disk
 */
export function syncSegment(writer: SegmentWriter): void {
    fs.fsyncSync(writer.fd);
}

/**
 * Seal a segment (mark as readonly)
 */
export function sealSegment(writer: SegmentWriter): WALSegment {
    const sealedAt = new Date();

    // Update header with sealed info
    writeSegmentHeader(writer, sealedAt);

    // Sync to disk
    syncSegment(writer);

    // Close file
    fs.closeSync(writer.fd);

    // Calculate segment checksum
    const segmentChecksum = combineCrc32(writer.eventChecksums);

    return {
        segmentId: writer.segmentId,
        startSequence: writer.startSequence,
        endSequence: writer.lastSequence,
        filePath: writer.filePath,
        sizeBytes: writer.currentOffset,
        sealed: true,
        segmentChecksum,
        createdAt: writer.createdAt.toISOString(),
        sealedAt: sealedAt.toISOString()
    };
}

/**
 * Close segment without sealing (for active segment on shutdown)
 */
export function closeSegment(writer: SegmentWriter): void {
    // Update header
    writeSegmentHeader(writer, null);
    syncSegment(writer);
    fs.closeSync(writer.fd);
}

/**
 * Get current segment size
 */
export function getSegmentSize(writer: SegmentWriter): number {
    return writer.currentOffset;
}

/**
 * Open a segment for reading
 */
export function openSegmentForReading(filePath: string): SegmentReader {
    const fd = fs.openSync(filePath, 'r');

    // Read and verify header
    const headerBuffer = Buffer.alloc(SEGMENT_HEADER_SIZE);
    fs.readSync(fd, headerBuffer, 0, SEGMENT_HEADER_SIZE, 0);

    // Verify magic number
    const magic = headerBuffer.readUInt32LE(0);
    if (magic !== MAGIC_NUMBER) {
        fs.closeSync(fd);
        throw new Error(`Invalid segment file: bad magic number ${magic}`);
    }

    // Parse header
    let offset = 4;
    const version = headerBuffer.readUInt32LE(offset);
    offset += 4;

    const segmentId = Number(headerBuffer.readBigInt64LE(offset));
    offset += 8;

    const startSequence = headerBuffer.readBigInt64LE(offset);
    offset += 8;

    const endSequence = headerBuffer.readBigInt64LE(offset);
    offset += 8;

    const eventCount = Number(headerBuffer.readBigInt64LE(offset));
    offset += 8;

    const createdAtMs = Number(headerBuffer.readBigInt64LE(offset));
    offset += 8;

    const sealedAtMs = Number(headerBuffer.readBigInt64LE(offset));
    offset += 8;

    const storedChecksum = headerBuffer.readUInt32LE(offset);

    // Verify header checksum
    const headerDataForChecksum = headerBuffer.subarray(0, offset);
    const computedChecksum = crc32(headerDataForChecksum);
    if (computedChecksum !== storedChecksum) {
        fs.closeSync(fd);
        throw new Error(`Segment header checksum mismatch: expected ${storedChecksum}, got ${computedChecksum}`);
    }

    const stats = fs.fstatSync(fd);

    const segment: WALSegment = {
        segmentId,
        startSequence,
        endSequence: endSequence === 0n ? null : endSequence,
        filePath,
        sizeBytes: stats.size,
        sealed: sealedAtMs !== 0,
        segmentChecksum: null, // Will be computed during verification
        createdAt: new Date(createdAtMs).toISOString(),
        sealedAt: sealedAtMs ? new Date(sealedAtMs).toISOString() : null
    };

    return {
        segment,
        fd,
        currentOffset: SEGMENT_HEADER_SIZE
    };
}

/**
 * Read next event from segment
 */
export function readNextEvent(reader: SegmentReader): WALEvent | null {
    const stats = fs.fstatSync(reader.fd);

    // Check if we've reached end of file
    if (reader.currentOffset >= stats.size) {
        return null;
    }

    // Read event header
    const headerBuffer = Buffer.alloc(EVENT_HEADER_SIZE);
    const bytesRead = fs.readSync(reader.fd, headerBuffer, 0, EVENT_HEADER_SIZE, reader.currentOffset);

    if (bytesRead < EVENT_HEADER_SIZE) {
        return null;
    }

    // Parse header
    let offset = 0;
    const sequence = headerBuffer.readBigInt64LE(offset);
    offset += 8;

    const timestampMicros = headerBuffer.readBigInt64LE(offset);
    offset += 8;

    const payloadLength = headerBuffer.readUInt32LE(offset);
    offset += 4;

    const tenantIdLength = headerBuffer.readUInt16LE(offset);
    offset += 2;

    const eventTypeLength = headerBuffer.readUInt16LE(offset);
    offset += 2;

    const storedChecksum = headerBuffer.readUInt32LE(offset);
    // Checksum is at offset 24, followed by 4 bytes reserved

    // Read data
    const dataLength = tenantIdLength + eventTypeLength + payloadLength;
    const dataBuffer = Buffer.alloc(dataLength);
    fs.readSync(reader.fd, dataBuffer, 0, dataLength, reader.currentOffset + EVENT_HEADER_SIZE);

    // Verify checksum - match exactly how write creates the checksum
    // Write does: Buffer.concat([eventBuffer.subarray(0, 24), eventBuffer.subarray(28)])
    // Which is: [header bytes 0-24] + [reserved (4 bytes)] + [data]
    const dataToChecksum = Buffer.concat([
        headerBuffer.subarray(0, 24),  // Header up to checksum field
        headerBuffer.subarray(28, 32), // Reserved field (after checksum)
        dataBuffer                      // All data
    ]);
    const computedChecksum = crc32(dataToChecksum);

    if (computedChecksum !== storedChecksum) {
        throw new Error(`Event checksum mismatch at offset ${reader.currentOffset}: expected ${storedChecksum}, got ${computedChecksum}`);
    }

    // Parse data
    let dataOffset = 0;
    const tenantId = dataBuffer.subarray(dataOffset, dataOffset + tenantIdLength).toString('utf-8');
    dataOffset += tenantIdLength;

    const eventType = dataBuffer.subarray(dataOffset, dataOffset + eventTypeLength).toString('utf-8');
    dataOffset += eventTypeLength;

    const payloadStr = dataBuffer.subarray(dataOffset, dataOffset + payloadLength).toString('utf-8');
    const payload = JSON.parse(payloadStr);

    // Update reader offset
    reader.currentOffset += EVENT_HEADER_SIZE + dataLength;

    // Convert timestamp
    const timestampMs = Number(timestampMicros / 1000n);
    const timestamp = new Date(timestampMs).toISOString();

    return {
        sequence,
        timestamp,
        tenantId,
        eventType,
        payload,
        checksum: storedChecksum
    };
}

/**
 * Close segment reader
 */
export function closeSegmentReader(reader: SegmentReader): void {
    fs.closeSync(reader.fd);
}

/**
 * List all segment files in directory
 */
export function listSegmentFiles(dataDir: string): string[] {
    if (!fs.existsSync(dataDir)) {
        return [];
    }

    return fs.readdirSync(dataDir)
        .filter(f => f.startsWith('wal_') && f.endsWith('.seg'))
        .sort()
        .map(f => path.join(dataDir, f));
}

/**
 * Verify segment integrity
 */
export function verifySegment(filePath: string): { valid: boolean; errors: string[]; eventCount: number } {
    const errors: string[] = [];
    let eventCount = 0;

    try {
        const reader = openSegmentForReading(filePath);

        while (true) {
            try {
                const event = readNextEvent(reader);
                if (!event) break;
                eventCount++;
            } catch (error) {
                errors.push(`Event ${eventCount + 1}: ${error instanceof Error ? error.message : String(error)}`);
                break;
            }
        }

        closeSegmentReader(reader);
    } catch (error) {
        errors.push(`Segment: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
        valid: errors.length === 0,
        errors,
        eventCount
    };
}
