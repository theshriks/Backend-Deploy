import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '../store';
import { Button, TextArea, Input } from '../components/ui';
import { Play, Pause, SkipBack, Zap } from 'lucide-react';

export const Streams: React.FC = () => {
  const { streams, streamMessages, publishMessage } = useStore();
  const [selectedStream, setSelectedStream] = useState(streams[0]);
  const [isPlaying, setIsPlaying] = useState(true);
  const [publishContent, setPublishContent] = useState('{"event": "ping"}');
  const scrollRef = useRef<HTMLDivElement>(null);

  const filteredMessages = streamMessages.filter(m => m.stream === selectedStream);

  // Auto-scroll effect
  useEffect(() => {
    if (isPlaying && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filteredMessages, isPlaying]);

  const handlePublish = () => {
    try {
      publishMessage(selectedStream, JSON.parse(publishContent));
      setPublishContent('{"event": "ping"}');
    } catch (e) {
      alert("Invalid JSON");
    }
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-6">
      {/* Stream List */}
      <div className="w-48 flex-shrink-0 border-r border-neutral-800 pr-4">
        <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-neutral-500">Streams</h3>
        <ul className="space-y-1">
          {streams.map(s => (
            <li key={s}>
              <button
                onClick={() => setSelectedStream(s)}
                className={`w-full rounded px-2 py-1.5 text-left text-sm flex items-center gap-2 ${
                  selectedStream === s 
                  ? 'bg-neutral-800 text-white' 
                  : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <Zap className="h-3 w-3" />
                {s}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Main Console */}
      <div className="flex-1 flex flex-col min-w-0 bg-black rounded-md border border-neutral-800 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900/50 px-4 py-2">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
              <span className="font-mono text-xs text-neutral-300">LIVE</span>
            </div>
            <span className="text-xs text-neutral-500 font-mono">{selectedStream}</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setIsPlaying(!isPlaying)} className="p-1 hover:bg-neutral-800 rounded">
              {isPlaying ? <Pause className="h-4 w-4 text-neutral-400" /> : <Play className="h-4 w-4 text-green-500" />}
            </button>
            <button className="p-1 hover:bg-neutral-800 rounded">
              <SkipBack className="h-4 w-4 text-neutral-400" />
            </button>
          </div>
        </div>

        {/* Log Output */}
        <div ref={scrollRef} className="flex-1 overflow-auto p-4 font-mono text-xs space-y-1">
          {filteredMessages.map((msg) => (
            <div key={msg.id} className="flex gap-4 hover:bg-neutral-900/50 px-1 rounded">
              <span className="text-neutral-600 w-32 shrink-0">{new Date(msg.timestamp).toISOString().split('T')[1].replace('Z','')}</span>
              <span className="text-blue-500 w-16 shrink-0">#{msg.offset}</span>
              <span className="text-neutral-300 break-all">{JSON.stringify(msg.payload)}</span>
            </div>
          ))}
          {filteredMessages.length === 0 && (
            <div className="text-neutral-600 italic p-4">Waiting for messages...</div>
          )}
        </div>
      </div>

      {/* Publish Panel */}
      <div className="w-72 flex-shrink-0 border-l border-neutral-800 pl-4 flex flex-col">
        <h3 className="mb-4 text-sm font-medium text-white">Publish Message</h3>
        <div className="space-y-4">
          <TextArea 
            rows={8} 
            value={publishContent} 
            onChange={e => setPublishContent(e.target.value)}
            className="font-mono text-xs"
          />
          <Button className="w-full" onClick={handlePublish}>Publish</Button>
          
          <div className="border-t border-neutral-800 pt-4 mt-4">
            <h4 className="text-xs font-semibold uppercase text-neutral-500 mb-2">Replay</h4>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Input placeholder="Offset" className="h-7 text-xs" />
                <Button size="sm" variant="secondary">Go</Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};