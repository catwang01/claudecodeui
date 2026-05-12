import type { CodeEditorFile } from '../types/types';
import { isImageFile } from '../utils/binaryFile';
import CodeEditor from './CodeEditor';
import ImageViewer from './ImageViewer';

type FileViewerProps = {
  file: CodeEditorFile;
  onClose: () => void;
  projectPath?: string;
  isSidebar?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: (() => void) | null;
  onPopOut?: (() => void) | null;
};

export default function FileViewer({
  file,
  onClose,
  projectPath,
  isSidebar = false,
  isExpanded = false,
  onToggleExpand = null,
  onPopOut = null,
}: FileViewerProps) {
  if (isImageFile(file.name)) {
    return (
      <ImageViewer
        file={file}
        onClose={onClose}
        projectPath={projectPath}
        isSidebar={isSidebar}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
        onPopOut={onPopOut}
      />
    );
  }

  return (
    <CodeEditor
      file={file}
      onClose={onClose}
      projectPath={projectPath}
      isSidebar={isSidebar}
      isExpanded={isExpanded}
      onToggleExpand={onToggleExpand}
      onPopOut={onPopOut}
    />
  );
}
