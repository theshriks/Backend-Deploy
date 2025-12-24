import React, { useState, useEffect } from 'react';
import { Layout } from './components/Layout';
import { View } from './types';
import { useStore } from './store';

// Pages
import { Dashboard } from './pages/Dashboard';
import { Documents } from './pages/Documents';
import { Streams } from './pages/Streams';
import { Cache } from './pages/Cache';
import { Storage } from './pages/Storage';
import { Audit } from './pages/Audit';
import { Alerts } from './pages/Alerts';
import { SDKDocs } from './pages/SDKDocs';
import { Settings } from './pages/Settings';

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<View>(View.DASHBOARD);
  const { 
    isAuthenticated, 
    currentProject, 
    loading, 
    error, 
    initializeProject,
    loadStateFromEvents 
  } = useStore();

  // Initialize project on app start
  useEffect(() => {
    const initApp = async () => {
      const projectID = 'shrik-core-v1'; // Production project ID
      
      if (!isAuthenticated) {
        console.log('[App] Initializing project...');
        await initializeProject(projectID);
      } else {
        console.log('[App] Loading existing state...');
        await loadStateFromEvents();
      }
    };

    initApp();
  }, [isAuthenticated, initializeProject, loadStateFromEvents]);

  // Show loading state during initialization
  if (loading && !isAuthenticated) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
          <p className="text-white">Initializing ShrikDB...</p>
          <p className="text-neutral-400 text-sm">Connecting to event log</p>
        </div>
      </div>
    );
  }

  // Show error state
  if (error && !isAuthenticated) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center space-y-4 max-w-md">
          <div className="rounded-full bg-red-900 p-4 mx-auto w-fit">
            <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h2 className="text-white text-xl font-semibold">Connection Failed</h2>
          <p className="text-red-400">{error}</p>
          <p className="text-neutral-400 text-sm">
            Make sure ShrikDB server is running on localhost:8080
          </p>
          <button 
            onClick={() => window.location.reload()} 
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const renderContent = () => {
    switch (currentView) {
      case View.DASHBOARD: return <Dashboard />;
      case View.DOCUMENTS: return <Documents />;
      case View.STREAMS: return <Streams />;
      case View.CACHE: return <Cache />;
      case View.STORAGE: return <Storage />;
      case View.AUDIT: return <Audit />;
      case View.ALERTS: return <Alerts />;
      case View.SDK: return <SDKDocs />;
      case View.SETTINGS: return <Settings />;
      default: return (
        <div className="flex h-full flex-col items-center justify-center space-y-4 text-neutral-500">
          <div className="rounded-full bg-neutral-900 p-4">
            <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <p>This module is currently under development.</p>
        </div>
      );
    }
  };

  return (
    <Layout currentView={currentView} setCurrentView={setCurrentView}>
      {renderContent()}
    </Layout>
  );
};

export default App;