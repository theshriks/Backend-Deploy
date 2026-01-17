/**
 * High-Performance Write Buffer
 * Pre-allocated buffer pool with zero-copy semantics
 */

const DEFAULT_BUFFER_SIZE = 16 * 1024 * 1024; // 16MB
const BUFFER_POOL_SIZE = 4;

export class WriteBuffer {
    private buffers: Buffer[] = [];
    private currentBuffer: Buffer;
    private currentOffset = 0;
    private bufferIndex = 0;
    private readonly bufferSize: number;

    constructor(bufferSize: number = DEFAULT_BUFFER_SIZE) {
        this.bufferSize = bufferSize;

        // Pre-allocate buffer pool
        for (let i = 0; i < BUFFER_POOL_SIZE; i++) {
            this.buffers.push(Buffer.allocUnsafe(bufferSize));
        }

        this.currentBuffer = this.buffers[0]!;
    }

    /**
     * Write data to buffer
     * Returns offset where data was written
     */
    write(data: Buffer): number {
        const offset = this.currentOffset;

        // Check if we need to expand
        if (this.currentOffset + data.length > this.bufferSize) {
            // Switch to next buffer in pool
            this.bufferIndex = (this.bufferIndex + 1) % BUFFER_POOL_SIZE;
            this.currentBuffer = this.buffers[this.bufferIndex]!;
            this.currentOffset = 0;
        }

        // Copy data (fast path)
        data.copy(this.currentBuffer, this.currentOffset);
        this.currentOffset += data.length;

        return offset;
    }

    /**
     * Get slice of current buffer for flushing
     */
    getFlushData(): Buffer {
        return this.currentBuffer.subarray(0, this.currentOffset);
    }

    /**
     * Reset buffer after flush
     */
    reset(): void {
        this.currentOffset = 0;
    }

    /**
     * Get current buffer usage
     */
    getUsage(): number {
        return this.currentOffset;
    }

    /**
     * Check if buffer has data
     */
    hasData(): boolean {
        return this.currentOffset > 0;
    }
}

/**
 * Ring buffer for event batching
 * Lock-free single-producer single-consumer
 */
export class EventRingBuffer<T> {
    private readonly buffer: (T | undefined)[];
    private readonly capacity: number;
    private head = 0;
    private tail = 0;
    private _size = 0;

    constructor(capacity: number) {
        this.capacity = capacity;
        this.buffer = new Array(capacity);
    }

    /**
     * Push item to ring buffer
     * Returns false if buffer is full
     */
    push(item: T): boolean {
        if (this._size >= this.capacity) {
            return false;
        }

        this.buffer[this.tail] = item;
        this.tail = (this.tail + 1) % this.capacity;
        this._size++;
        return true;
    }

    /**
     * Pop item from ring buffer
     * Returns undefined if empty
     */
    pop(): T | undefined {
        if (this._size === 0) {
            return undefined;
        }

        const item = this.buffer[this.head];
        this.buffer[this.head] = undefined;
        this.head = (this.head + 1) % this.capacity;
        this._size--;
        return item;
    }

    /**
     * Drain up to N items
     */
    drain(maxItems: number): T[] {
        const items: T[] = [];
        const count = Math.min(maxItems, this._size);

        for (let i = 0; i < count; i++) {
            const item = this.pop();
            if (item !== undefined) {
                items.push(item);
            }
        }

        return items;
    }

    get size(): number {
        return this._size;
    }

    get isFull(): boolean {
        return this._size >= this.capacity;
    }

    get isEmpty(): boolean {
        return this._size === 0;
    }
}
