# ShrikDB Streams Layer (Phase 2A)

## Overview

The Streams layer provides a Kafka-like streaming abstraction built as a **pure derivation** of the existing ShrikDB event log (Phase 1A/1B). It does not create new write paths or storage - all stream messages are events in the existing log.

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Streams API   │───▶│   Event Log      │───▶│   Storage       │
│   (Phase 2A)    │    │   (Phase 1A)     │    │   (Phase 1B)    │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

### Key Principles

1. **Pure Derivation**: Streams are projections, not sources of truth
2. **Event Log Integration**: Uses existing AppendEvent API for writes
3. **Deterministic Replay**: Same log → same stream output
4. **Project Isolation**: Uses project_id for multi-tenancy
5. **Offset Storage**: Consumer offsets stored as events in the log

## Integration with Phase 1A/1B

### Required Phase 1A APIs
- `AppendEvent(project_id, event_type, payload)` - Write events
- `ReplayEvents(project_id, from_sequence)` - Read events in order
- `GetEventsByTimestamp(project_id, timestamp)` - Timestamp-based replay

### Event Schema
All stream operations use the existing event schema:
```json
{
  "sequence_number": 123,
  "project_id": "project-uuid",
  "event_type": "stream_message" | "offset_committed",
  "timestamp": "2023-12-23T10:00:00Z",
  "payload": { ... }
}
```

## API Usage

### Publishing Messages
```javascript
const streams = new StreamsAPI(eventLog);
await streams.publish('user-events', { userId: 123, action: 'login' });
```

### Consuming Messages
```javascript
const consumer = streams.subscribe('user-events', 'consumer-group-1');
for await (const message of consumer) {
  console.log(message);
  await consumer.commitOffset();
}
```

### Replay from Offset
```javascript
const consumer = streams.replay('user-events', { fromOffset: 100 });
```

### Replay from Timestamp
```javascript
const consumer = streams.replay('user-events', { 
  fromTimestamp: '2023-12-23T10:00:00Z' 
});
```

## Guarantees

- **At-least-once delivery**: Messages may be redelivered on failure
- **Strict ordering**: By sequence_number from event log
- **Deterministic replay**: Rebuilding from log produces identical streams
- **Project isolation**: Streams are isolated by project_id

## State Recovery

All stream state can be rebuilt by replaying the event log:
1. Delete all consumer offset state
2. Replay events from sequence 0
3. Rebuild consumer positions and stream state
4. Resume normal operation

This ensures the streams layer remains a pure derivation of the event log.