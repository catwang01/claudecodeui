import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { FILE_STATUS_GROUPS } from '../../constants/constants';
import type { FileStatusCode, GitDiffMap, GitStatusResponse } from '../../types/types';
import { buildFileTree, getAllLeafPaths, type FileTreeNode } from '../../utils/fileTreeUtils';
import FileChangeItem from './FileChangeItem';

type FileTreeViewProps = {
  gitStatus: GitStatusResponse;
  gitDiff: GitDiffMap;
  expandedFiles: Set<string>;
  selectedFiles: Set<string>;
  isMobile: boolean;
  wrapText: boolean;
  filePaths?: Set<string>;
  onToggleSelected: (filePath: string) => void;
  onToggleExpanded: (filePath: string) => void;
  onOpenFile: (filePath: string) => void;
  onToggleWrapText: () => void;
  onRequestFileAction: (filePath: string, status: FileStatusCode) => void;
};

/** Build a flat array of {path, status} from gitStatus filtered by an optional filePaths set. */
function getFilteredFilesWithStatus(
  gitStatus: GitStatusResponse,
  filePaths?: Set<string>,
): Array<{ path: string; status: FileStatusCode }> {
  return FILE_STATUS_GROUPS.flatMap(({ key, status }) =>
    (gitStatus[key] || [])
      .filter((p) => !filePaths || filePaths.has(p))
      .map((path) => ({ path, status })),
  );
}

// ---------------------------------------------------------------------------
// TreeNode — recursive sub-component
// ---------------------------------------------------------------------------

type TreeNodeProps = {
  node: FileTreeNode;
  depth: number;
  gitDiff: GitDiffMap;
  expandedFiles: Set<string>;
  selectedFiles: Set<string>;
  collapsedDirs: Set<string>;
  isMobile: boolean;
  wrapText: boolean;
  onToggleSelected: (filePath: string) => void;
  onToggleExpanded: (filePath: string) => void;
  onToggleDirCollapsed: (dirPath: string) => void;
  onToggleDirSelected: (node: FileTreeNode) => void;
  onOpenFile: (filePath: string) => void;
  onToggleWrapText: () => void;
  onRequestFileAction: (filePath: string, status: FileStatusCode) => void;
};

function TreeNode({
  node,
  depth,
  gitDiff,
  expandedFiles,
  selectedFiles,
  collapsedDirs,
  isMobile,
  wrapText,
  onToggleSelected,
  onToggleExpanded,
  onToggleDirCollapsed,
  onToggleDirSelected,
  onOpenFile,
  onToggleWrapText,
  onRequestFileAction,
}: TreeNodeProps) {
  const indent = depth * (isMobile ? 12 : 16);

  if (!node.isDir) {
    // File leaf — render FileChangeItem with extra indentation wrapper
    return (
      <div style={{ paddingLeft: indent }}>
        <FileChangeItem
          filePath={node.fullPath}
          displayName={node.name}
          status={node.status!}
          isMobile={isMobile}
          isExpanded={expandedFiles.has(node.fullPath)}
          isSelected={selectedFiles.has(node.fullPath)}
          diff={gitDiff[node.fullPath]}
          wrapText={wrapText}
          onToggleSelected={onToggleSelected}
          onToggleExpanded={onToggleExpanded}
          onOpenFile={onOpenFile}
          onToggleWrapText={onToggleWrapText}
          onRequestFileAction={onRequestFileAction}
        />
      </div>
    );
  }

  // Directory node
  const isCollapsed = collapsedDirs.has(node.fullPath);
  const leafPaths = getAllLeafPaths(node);
  const selectedCount = leafPaths.filter((p) => selectedFiles.has(p)).length;
  const isAllSelected = leafPaths.length > 0 && selectedCount === leafPaths.length;
  const isIndeterminate = selectedCount > 0 && selectedCount < leafPaths.length;

  // base px-3 (12px) is built into FileChangeItem; replicate it for dir header
  const dirPaddingLeft = indent + 12;

  return (
    <div>
      {/* Directory header row */}
      <div
        className={`flex items-center border-b border-border/40 hover:bg-accent/30 ${isMobile ? 'py-1' : 'py-1.5'}`}
        style={{ paddingLeft: dirPaddingLeft, paddingRight: 12 }}
      >
        {/* Aggregate checkbox */}
        <input
          type="checkbox"
          checked={isAllSelected}
          ref={(el) => {
            if (el) el.indeterminate = isIndeterminate;
          }}
          onChange={() => onToggleDirSelected(node)}
          onClick={(e) => e.stopPropagation()}
          className={`rounded border-border bg-background text-primary checked:bg-primary focus:ring-primary/40 ${isMobile ? 'mr-1.5' : 'mr-2'}`}
        />

        {/* Collapse/expand + dir name */}
        <button
          onClick={() => onToggleDirCollapsed(node.fullPath)}
          className="flex flex-1 items-center gap-1 text-left"
          title={isCollapsed ? 'Expand directory' : 'Collapse directory'}
        >
          <ChevronRight
            className={`h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150 ${isCollapsed ? '' : 'rotate-90'}`}
          />
          {isCollapsed ? (
            <Folder className={`flex-shrink-0 text-muted-foreground ${isMobile ? 'mr-1 h-3 w-3' : 'mr-1 h-3.5 w-3.5'}`} />
          ) : (
            <FolderOpen className={`flex-shrink-0 text-muted-foreground ${isMobile ? 'mr-1 h-3 w-3' : 'mr-1 h-3.5 w-3.5'}`} />
          )}
          <span className={`truncate font-medium text-foreground ${isMobile ? 'text-xs' : 'text-sm'}`}>
            {node.name}
          </span>
          <span className="ml-1 flex-shrink-0 text-xs text-muted-foreground">
            ({leafPaths.length})
          </span>
        </button>
      </div>

      {/* Children */}
      {!isCollapsed &&
        node.children.map((child) => (
          <TreeNode
            key={child.fullPath}
            node={child}
            depth={depth + 1}
            gitDiff={gitDiff}
            expandedFiles={expandedFiles}
            selectedFiles={selectedFiles}
            collapsedDirs={collapsedDirs}
            isMobile={isMobile}
            wrapText={wrapText}
            onToggleSelected={onToggleSelected}
            onToggleExpanded={onToggleExpanded}
            onToggleDirCollapsed={onToggleDirCollapsed}
            onToggleDirSelected={onToggleDirSelected}
            onOpenFile={onOpenFile}
            onToggleWrapText={onToggleWrapText}
            onRequestFileAction={onRequestFileAction}
          />
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileTreeView — public component
// ---------------------------------------------------------------------------

export default function FileTreeView({
  gitStatus,
  gitDiff,
  expandedFiles,
  selectedFiles,
  isMobile,
  wrapText,
  filePaths,
  onToggleSelected,
  onToggleExpanded,
  onOpenFile,
  onToggleWrapText,
  onRequestFileAction,
}: FileTreeViewProps) {
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());

  const files = useMemo(
    () => getFilteredFilesWithStatus(gitStatus, filePaths),
    [gitStatus, filePaths],
  );

  const tree = useMemo(() => buildFileTree(files), [files]);

  const handleToggleDirCollapsed = useCallback((dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  }, []);

  const handleToggleDirSelected = useCallback(
    (node: FileTreeNode) => {
      const leafPaths = getAllLeafPaths(node);
      const allSelected = leafPaths.every((p) => selectedFiles.has(p));
      for (const path of leafPaths) {
        const isSelected = selectedFiles.has(path);
        if (allSelected ? isSelected : !isSelected) {
          onToggleSelected(path);
        }
      }
    },
    [selectedFiles, onToggleSelected],
  );

  return (
    <>
      {tree.children.map((node) => (
        <TreeNode
          key={node.fullPath}
          node={node}
          depth={0}
          gitDiff={gitDiff}
          expandedFiles={expandedFiles}
          selectedFiles={selectedFiles}
          collapsedDirs={collapsedDirs}
          isMobile={isMobile}
          wrapText={wrapText}
          onToggleSelected={onToggleSelected}
          onToggleExpanded={onToggleExpanded}
          onToggleDirCollapsed={handleToggleDirCollapsed}
          onToggleDirSelected={handleToggleDirSelected}
          onOpenFile={onOpenFile}
          onToggleWrapText={onToggleWrapText}
          onRequestFileAction={onRequestFileAction}
        />
      ))}
    </>
  );
}
