import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui';
import { useStore } from '../store';
import { Activity, Database, Server, HardDrive } from 'lucide-react';

const MetricCard: React.FC<{ title: string; value: string; icon: React.ReactNode }> = ({ title, value, icon }) => (
  <Card>
    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
      <CardTitle className="text-sm font-medium text-neutral-400">{title}</CardTitle>
      <div className="text-neutral-500">{icon}</div>
    </CardHeader>
    <CardContent>
      <div className="text-2xl font-bold text-white">{value}</div>
    </CardContent>
  </Card>
);

export const Dashboard: React.FC = () => {
  const { documents, streams, files, auditLogs } = useStore();

  return (
    <div className="space-y-6">
      {/* Metrics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard 
          title="Total Documents" 
          value={documents.length.toString()} 
          icon={<Database className="h-4 w-4"/>} 
        />
        <MetricCard 
          title="Active Streams" 
          value={streams.length.toString()} 
          icon={<Activity className="h-4 w-4"/>} 
        />
        <MetricCard 
          title="Events / Sec" 
          value="4,291" 
          icon={<Server className="h-4 w-4"/>} 
        />
        <MetricCard 
          title="Storage Used" 
          value={`${files.reduce((acc, f) => acc + f.size, 0) / 1024} MB`} 
          icon={<HardDrive className="h-4 w-4"/>} 
        />
      </div>

      {/* Recent Activity */}
      <Card className="col-span-4">
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            {auditLogs.slice(0, 10).map((log) => (
              <div key={log.id} className="flex items-center justify-between border-b border-neutral-800 py-3 last:border-0">
                <div className="flex items-center gap-4">
                  <div className={`h-2 w-2 rounded-full ${
                    log.type === 'INSERT' ? 'bg-green-500' :
                    log.type === 'DELETE' ? 'bg-red-500' :
                    log.type === 'UPDATE' ? 'bg-blue-500' : 'bg-neutral-500'
                  }`} />
                  <div className="space-y-1">
                    <p className="text-sm font-medium leading-none text-white">
                      {log.type} <span className="text-neutral-500">on</span> {log.entity}
                    </p>
                    <p className="text-xs text-neutral-500 font-mono">{log.hash}</p>
                  </div>
                </div>
                <div className="text-xs text-neutral-500 font-mono">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};