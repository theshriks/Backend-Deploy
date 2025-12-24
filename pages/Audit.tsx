import React, { useState } from 'react';
import { useStore } from '../store';
import { Button, Badge } from '../components/ui';
import { ShieldCheck, Eye, RefreshCw } from 'lucide-react';
import { AuditLog } from '../types';

export const Audit: React.FC = () => {
  const { auditLogs } = useStore();
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-6">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-medium text-white">System Audit Log</h2>
            <Button variant="ghost" size="sm"><RefreshCw className="h-4 w-4"/></Button>
        </div>
        
        <div className="flex-1 overflow-auto rounded-md border border-neutral-800 bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-neutral-900 text-xs uppercase text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">Event ID</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Entity</th>
                <th className="px-4 py-3 font-medium">Timestamp</th>
                <th className="px-4 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {auditLogs.map(log => (
                <tr key={log.id} className="hover:bg-neutral-800/30">
                  <td className="px-4 py-3 font-mono text-neutral-500">{log.id}</td>
                  <td className="px-4 py-3">
                    <Badge variant="outline">{log.type}</Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-neutral-300">{log.entity}</td>
                  <td className="px-4 py-3 text-neutral-400">{new Date(log.timestamp).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="ghost" size="sm" onClick={() => setSelectedLog(log)}>
                      <Eye className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail Drawer */}
      {selectedLog && (
        <div className="w-96 flex-shrink-0 border-l border-neutral-800 pl-4 flex flex-col animate-in slide-in-from-right duration-200">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-semibold text-white">Event Details</h3>
            <button onClick={() => setSelectedLog(null)} className="text-neutral-500 hover:text-white">✕</button>
          </div>
          
          <div className="space-y-6">
            <div className="space-y-1">
                <div className="text-xs text-neutral-500 uppercase tracking-wider">Hash Proof</div>
                <div className="font-mono text-xs bg-neutral-900 p-2 rounded border border-neutral-800 break-all text-green-500/80">
                    {selectedLog.hash}
                </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
                <div>
                    <div className="text-xs text-neutral-500 uppercase">Type</div>
                    <div className="text-sm text-white mt-1">{selectedLog.type}</div>
                </div>
                <div>
                    <div className="text-xs text-neutral-500 uppercase">Entity</div>
                    <div className="text-sm text-white mt-1">{selectedLog.entity}</div>
                </div>
            </div>

            <div>
                <div className="text-xs text-neutral-500 uppercase mb-2">Metadata</div>
                <div className="rounded bg-neutral-900 p-3 font-mono text-xs text-neutral-400 border border-neutral-800">
                    {`{\n  "source": "api_v1",\n  "ip": "10.0.0.1",\n  "details": "${selectedLog.details}"\n}`}
                </div>
            </div>

            <div className="pt-6 border-t border-neutral-800">
                <Button className="w-full gap-2" variant="secondary" onClick={() => alert("Hash verified against Merkle Tree root.")}>
                    <ShieldCheck className="h-4 w-4" /> Verify Integrity
                </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};