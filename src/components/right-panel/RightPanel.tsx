import { FileCode, Maximize2, Minimize2, X } from 'lucide-react';
import FileTree from '../file-tree/view/FileTree';
import GitPanel from '../git-panel/view/GitPanel';
import FileViewer from '../code-editor/view/FileViewer';
import type { RightPanelTab } from '../../hooks/useChatRightPanel';
import type { CodeEditorFile } from '../code-editor/types/types';
import type { Project } from '../../types/app';

interface RightPanelProps {
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  onClose: () => void;
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
  editingFile: CodeEditorFile | null;
  editorExpanded: boolean;
  onCloseFile: () => void;
  onToggleEditorExpand: () => void;
  isMobile: boolean;
  projectPath?: string;
}

export default function RightPanel({
  activeTab,
  onTabChange,
  onClose,
  selectedProject,
  onFileOpen,
  editingFile,
  editorExpanded,
  onCloseFile,
  onToggleEditorExpand,
  isMobile,
  projectPath,
}: RightPanelProps) {
  // Mobile: show FileViewer as full-screen overlay when editor tab is active
  if (isMobile && activeTab === 'editor' && editingFile) {
    return (
      <FileViewer
        key={editingFile.path}
        file={editingFile}
        onClose={onCloseFile}
        projectPath={projectPath}
        isSidebar={false}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-l border-border/60 bg-background">
      {/* Panel header */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <div role="tablist" className="flex items-center">
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
          {editingFile && (
            <button
              role="tab"
              aria-selected={activeTab === 'editor'}
              onClick={() => onTabChange('editor')}
              className={`flex items-center gap-1 rounded px-2.5 py-1 text-sm font-medium transition-colors ${
                activeTab === 'editor'
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <FileCode className="h-3.5 w-3.5" />
              <span className="max-w-[120px] truncate">{editingFile.name}</span>
            </button>
          )}
        </div>

        <div className="flex-1" />

        {activeTab === 'editor' && editingFile && (
          <button
            aria-label={editorExpanded ? 'Collapse editor' : 'Expand editor'}
            onClick={onToggleEditorExpand}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {editorExpanded ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
        )}

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
        {activeTab === 'files' && (
          <FileTree selectedProject={selectedProject} onFileOpen={onFileOpen} />
        )}
        {activeTab === 'git' && (
          <GitPanel selectedProject={selectedProject} onFileOpen={onFileOpen} />
        )}
        {activeTab === 'editor' && editingFile && (
          <FileViewer
            key={editingFile.path}
            file={editingFile}
            onClose={onCloseFile}
            projectPath={projectPath}
            isSidebar
            isExpanded={editorExpanded}
            onToggleExpand={onToggleEditorExpand}
          />
        )}
      </div>
    </div>
  );
}
