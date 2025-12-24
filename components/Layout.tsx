import React from 'react';
import { View } from '../types';
import { cn } from './ui';
import { 
  LayoutDashboard, 
  Files, 
  Activity, 
  Zap, 
  HardDrive, 
  ShieldCheck, 
  Bell, 
  BookOpen, 
  Settings, 
  ChevronDown, 
  User,
  LogOut
} from 'lucide-react';
import { useStore } from '../store';

const NavItem: React.FC<{ 
  view: View; 
  current: View; 
  icon: React.ReactNode; 
  onClick: (v: View) => void 
}> = ({ view, current, icon, onClick }) => (
  <button 
    onClick={() => onClick(view)}
    className={cn(
      "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
      current === view 
        ? "bg-neutral-800 text-white" 
        : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
    )}
  >
    {icon}
    <span>{view}</span>
  </button>
);

interface LayoutProps {
  currentView: View;
  setCurrentView: (v: View) => void;
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ currentView, setCurrentView, children }) => {
  const { currentProject, clientID, isAuthenticated, loading, replayAndVerify } = useStore();

  const handleReplayVerify = async () => {
    if (confirm('Trigger replay verification? This will verify all events in the log.')) {
      await replayAndVerify();
    }
  };

  return (
    <div className="flex h-screen w-full bg-background text-text overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 flex-shrink-0 border-r border-border bg-surface flex flex-col">
        <div className="p-4 border-b border-border">
          <h1 className="text-lg font-bold tracking-tight text-white mb-4">ShrikDB</h1>
          <div className="space-y-2">
            <button className="flex w-full items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-sm text-neutral-300 hover:border-neutral-600">
              <span className="truncate">{currentProject || 'No Project'}</span>
              <ChevronDown className="h-4 w-4 opacity-50" />
            </button>
            {isAuthenticated && (
              <div className="text-xs text-neutral-500 px-2">
                Client: {clientID?.substring(0, 12)}...
              </div>
            )}
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-2 overflow-y-auto">
          <NavItem view={View.DASHBOARD} current={currentView} icon={<LayoutDashboard className="h-4 w-4"/>} onClick={setCurrentView} />
          <NavItem view={View.DOCUMENTS} current={currentView} icon={<Files className="h-4 w-4"/>} onClick={setCurrentView} />
          <NavItem view={View.STREAMS} current={currentView} icon={<Activity className="h-4 w-4"/>} onClick={setCurrentView} />
          <NavItem view={View.CACHE} current={currentView} icon={<Zap className="h-4 w-4"/>} onClick={setCurrentView} />
          <NavItem view={View.STORAGE} current={currentView} icon={<HardDrive className="h-4 w-4"/>} onClick={setCurrentView} />
          <NavItem view={View.AUDIT} current={currentView} icon={<ShieldCheck className="h-4 w-4"/>} onClick={setCurrentView} />
          <NavItem view={View.ALERTS} current={currentView} icon={<Bell className="h-4 w-4"/>} onClick={setCurrentView} />
          
          <div className="my-4 border-t border-border mx-2"></div>
          
          <NavItem view={View.SDK} current={currentView} icon={<BookOpen className="h-4 w-4"/>} onClick={setCurrentView} />
          <NavItem view={View.SETTINGS} current={currentView} icon={<Settings className="h-4 w-4"/>} onClick={setCurrentView} />
        </nav>

        {/* Replay Verification Button */}
        {isAuthenticated && (
          <div className="p-2 border-t border-border">
            <button
              onClick={handleReplayVerify}
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white text-xs px-3 py-2 rounded-md transition-colors"
            >
              {loading ? 'Verifying...' : 'Verify Replay'}
            </button>
          </div>
        )}

        <div className="p-4 border-t border-border text-xs text-neutral-500">
          Phase 1A - Production
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Top Bar */}
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
          <div className="flex items-center gap-4">
            <span className="text-sm font-medium text-white">{currentView}</span>
            <span className="bg-green-950 text-green-500 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
              PROD
            </span>
            {isAuthenticated && (
              <span className="bg-blue-950 text-blue-400 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                EVENT-SOURCED
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-neutral-400 hover:text-white cursor-pointer">
              <User className="h-4 w-4" />
              <span>admin@shrik.io</span>
            </div>
            <LogOut className="h-4 w-4 text-neutral-500 hover:text-white cursor-pointer" />
          </div>
        </header>

        {/* Content Area */}
        <main className="flex-1 overflow-auto bg-background p-6">
          {children}
        </main>
      </div>
    </div>
  );
};