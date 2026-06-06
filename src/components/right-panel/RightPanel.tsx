import { X } from 'lucide-react';
import FileTree from '../file-tree/view/FileTree';
import GitPanel from '../git-panel/view/GitPanel';
import type { RightPanelTab } from '../../hooks/useChatRightPanel';
import type { Project } from '../../types/app';

interface RightPanelProps {
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  onClose: () => void;
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
}

export default function RightPanel({
  activeTab,
  onTabChange,
  onClose,
  selectedProject,
  onFileOpen,
}: RightPanelProps) {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-l border-border/60 bg-background">
      {/* Panel header */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <div role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === 'files'}
            onClick={() => onTabChange('files')}
            className={`rounded px-2.5 py-1 text-sm font-medium transition-colors ${
              activeTab === 'files'
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Files
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'git'}
            onClick={() => onTabChange('git')}
            className={`rounded px-2.5 py-1 text-sm font-medium transition-colors ${
              activeTab === 'git'
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Git
          </button>
        </div>

        <div className="flex-1" />

        <button
          aria-label="Close panel"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Panel content */}
      <div role="tabpanel" className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'files' ? (
          <FileTree selectedProject={selectedProject} onFileOpen={onFileOpen} />
        ) : (
          <GitPanel selectedProject={selectedProject} onFileOpen={onFileOpen} />
        )}
      </div>
    </div>
  );
}
